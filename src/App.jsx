import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { GitBranch, ListTodo, Zap, Inbox, Settings, Activity } from 'lucide-react';
import WorkflowList from './pages/builder/WorkflowList';
import WorkflowBuilder from './pages/builder/WorkflowBuilder';
import TaskRegistry from './pages/builder/TaskRegistry';
import ActionRegistry from './pages/builder/ActionRegistry';
import WorkBucket from './pages/workbucket/WorkBucket';
import UserSelect from './pages/workbucket/UserSelect';
import Orchestrator from './pages/orchestrator/Orchestrator';

function Sidebar() {
  const navItem = (to, icon, label, end) => (
    <NavLink to={to} end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isActive ? 'bg-violet-100 text-violet-700' : 'text-slate-600 hover:bg-slate-100'}`
      }>
      {icon}
      <span>{label}</span>
    </NavLink>
  );

  return (
    <aside className="w-56 shrink-0 border-r border-slate-100 bg-white flex flex-col min-h-screen">
      <div className="px-4 py-5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center">
            <GitBranch size={14} className="text-white" />
          </div>
          <span className="font-bold text-slate-800 text-sm">FlowPOC</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        <div className="text-xs font-semibold text-slate-400 px-3 py-1 uppercase tracking-wider">Builder</div>
        {navItem('/builder/workflows', <GitBranch size={16} />, 'Workflows', true)}
        {navItem('/builder/tasks', <ListTodo size={16} />, 'Task Registry', true)}
        {navItem('/builder/actions', <Zap size={16} />, 'Action Registry', true)}

        <div className="text-xs font-semibold text-slate-400 px-3 py-1 mt-4 uppercase tracking-wider">Execution</div>
        {navItem('/orchestrator', <Activity size={16} />, 'Orchestrator', true)}
        {navItem('/worker', <Inbox size={16} />, 'Work Bucket', true)}
      </nav>

      <div className="p-3 border-t border-slate-100 space-y-1">
        <a href={`${import.meta.env.BASE_URL}worker.html`} target="_blank" rel="noreferrer"
          className="flex items-center gap-2 px-3 py-2 text-xs text-violet-600 hover:bg-violet-50 rounded-lg font-medium transition-colors">
          <Inbox size={13} />
          <span>Open Worker UI ↗</span>
        </a>
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
          <Settings size={13} />
          <span>POC — localStorage</span>
        </div>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/builder/workflows" replace />} />
            <Route path="/builder/workflows" element={<WorkflowList />} />
            <Route path="/builder/create" element={<WorkflowBuilder />} />
            <Route path="/builder/tasks" element={<TaskRegistry />} />
            <Route path="/builder/actions" element={<ActionRegistry />} />
            <Route path="/orchestrator" element={<Orchestrator />} />
            <Route path="/worker" element={<UserSelect />} />
            <Route path="/worker/bucket/:userId" element={<WorkBucket />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
