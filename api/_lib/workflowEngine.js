import {
  getItem,
  getItemTasks,
  getRunItems,
  getTaskRun,
  updateItem,
  updateRunStatus,
  updateTask,
} from './repositories.js';
import { evaluateCondition, taskDisplayPayload, taskRegistry } from './taskRegistry.js';

function stepById(definition) {
  return Object.fromEntries((definition.steps || []).map((step) => [step.id, step]));
}

function taskByStep(tasks) {
  return Object.fromEntries(tasks.map((task) => [task.step_id, task]));
}

function prereqsSatisfied(step, taskMap) {
  const prereqs = step.preReq || [];
  return prereqs.every((stepId) => {
    const task = taskMap[stepId];
    return task && ['completed', 'skipped'].includes(task.status);
  });
}

// A step is UNREACHABLE when it has prerequisites but every one of them was
// skipped (none completed) — i.e. no incoming branch was actually taken. The
// engine treats `skipped` as satisfying a preReq so the untaken arm of a diamond
// never blocks the join; but when BOTH/ALL arms feeding a join skipped, the join
// itself sits on an untaken path and must skip too (rather than spuriously
// activating). Steps with no prerequisites (entry) are always reachable.
function prereqsAllSkipped(step, taskMap) {
  const prereqs = step.preReq || [];
  if (!prereqs.length) return false;
  return prereqs.every((stepId) => taskMap[stepId]?.status === 'skipped');
}

function terminal(task) {
  return ['completed', 'skipped', 'failed'].includes(task.status);
}

function hasActiveHuman(tasks) {
  return tasks.some((task) => task.status === 'active' && task.actor === 'human');
}

export async function runItemAutomation({ definition, itemId, context = {} }) {
  const steps = stepById(definition);
  let changed = true;

  while (changed) {
    changed = false;
    const item = await getItem(itemId);
    if (!item || item.status === 'completed') break;
    const tasks = await getItemTasks(itemId);
    const taskMap = taskByStep(tasks);

    for (const task of tasks) {
      if (task.status !== 'pending') continue;
      const step = steps[task.step_id];
      if (!step || !prereqsSatisfied(step, taskMap)) continue;

      // Unreachable join: every prerequisite skipped => this step is on an
      // untaken path. Skip it (and let the skip cascade to its own successors).
      if (prereqsAllSkipped(step, taskMap)) {
        await updateTask(task.id, {
          status: 'skipped',
          completedAt: new Date().toISOString(),
          output: { unreachable: true, skipped: true },
        });
        changed = true;
        break;
      }

      const freshItem = await getItem(itemId);
      const conditionMet = await evaluateCondition(step.condition, freshItem);
      if (!conditionMet) {
        await updateTask(task.id, {
          status: 'skipped',
          completedAt: new Date().toISOString(),
          output: { condition: step.condition || null, skipped: true },
        });
        changed = true;
        break;
      }

      if (step.actor === 'human') {
        // Keep whatever assignee the task row already carries (builder-set
        // assigned_employee_id, or NULL = shared across every employee's
        // Untouched bucket for system workflows). No random assignment.
        await updateTask(task.id, {
          status: 'active',
          startedAt: new Date().toISOString(),
          output: taskDisplayPayload(freshItem),
        });
        changed = true;
        break;
      }

      await updateTask(task.id, {
        status: 'active',
        startedAt: new Date().toISOString(),
      });
      const fn = taskRegistry[step.taskKey];
      if (!fn) {
        await updateTask(task.id, {
          status: 'failed',
          errorMessage: `No task registered for ${step.taskKey}`,
          completedAt: new Date().toISOString(),
        });
        await updateItem(itemId, { status: 'failed', errorMessage: `No task registered for ${step.taskKey}` });
        return;
      }

      const result = await fn({ item: freshItem, step, task, context });
      if (result.waiting) {
        await updateTask(task.id, {
          status: 'active',
          output: result.output ?? result,
          errorMessage: null,
        });
        changed = true;
        break;
      }
      await updateTask(task.id, {
        status: result.ok === false ? 'failed' : 'completed',
        output: result.output ?? result,
        errorMessage: result.error || null,
        completedAt: new Date().toISOString(),
      });
      if (result.ok === false) {
        await updateItem(itemId, { status: 'failed', errorMessage: result.error || `${step.name} failed` });
        return;
      }
      changed = true;
      break;
    }
  }

  const finalTasks = await getItemTasks(itemId);
  if (finalTasks.length && finalTasks.every(terminal)) {
    const live = finalTasks.filter((task) => task.status !== 'skipped');
    if (live.every((task) => task.status === 'completed')) {
      await updateItem(itemId, { status: 'completed' });
    }
  } else if (hasActiveHuman(finalTasks)) {
    await updateItem(itemId, { status: 'blocked' });
  } else {
    await updateItem(itemId, { status: 'running' });
  }
}

async function runLimited(items, limit, fn) {
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    await Promise.all(batch.map(fn));
  }
}

export async function runWorkflowAutomation({ runId, definition, context = {}, concurrency = 10 }) {
  const items = await getRunItems(runId);
  const runnable = items.filter((item) => item.status !== 'completed' && item.status !== 'failed');
  await runLimited(runnable, Math.max(1, Number(concurrency) || 10), (item) => (
    runItemAutomation({ definition, itemId: item.id, context })
  ));
  await updateRunStatus(runId);
}

export async function completeHumanTask({ taskRunId, notes, payload, definition }) {
  const task = await getTaskRun(taskRunId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'active') throw new Error('Task is not active');
  const item = await getItem(task.item_id);
  const step = (definition.steps || []).find((s) => s.id === task.step_id);
  const fn = taskRegistry[task.task_key];
  if (!step || !fn) throw new Error(`Task implementation missing for ${task.task_key}`);
  const result = await fn({ item, step, task, payload: payload || {} });

  // Validation-retry rule: a { retry: true } result keeps the task active (and
  // opened => still Processing) and surfaces per-action errors as a 400 —
  // nothing is marked failed. Used by human.performActions.
  if (result?.retry === true) {
    const error = new Error(result.error || 'Validation failed');
    error.status = 400;
    error.details = { actionErrors: result.actionErrors || {} };
    throw error;
  }

  await updateItem(item.id, { status: 'running' });
  await updateTask(task.id, {
    status: result.ok === false ? 'failed' : 'completed',
    notes: notes || '',
    output: result.output ?? result,
    errorMessage: result.error || null,
    completedAt: new Date().toISOString(),
  });
  if (result.ok === false) {
    await updateItem(item.id, { status: 'failed', errorMessage: result.error || `${step.name} failed` });
  }
  await runWorkflowAutomation({ runId: task.run_id, definition });

  return { task, result };
}
