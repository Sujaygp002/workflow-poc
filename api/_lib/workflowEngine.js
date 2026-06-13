import {
  getItem,
  getItemTasks,
  getTaskRun,
  getRunItems,
  listUsers,
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

function terminal(task) {
  return ['completed', 'skipped', 'failed'].includes(task.status);
}

function hasActiveHuman(tasks) {
  return tasks.some((task) => task.status === 'active' && task.actor === 'human');
}

async function assignHuman() {
  const users = await listUsers();
  if (!users.length) return null;
  return users[Math.floor(Math.random() * users.length)].id;
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
        await updateTask(task.id, {
          status: 'active',
          assignedTo: task.assigned_to || await assignHuman(),
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
