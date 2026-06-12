import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { Activity, ClipboardList, Database, GitBranch, Inbox, Zap } from 'lucide-react';
import WorkflowList from './pages/builder/WorkflowList';
import WorkBucket from './pages/workbucket/WorkBucket';
import UserSelect from './pages/workbucket/UserSelect';
import Orchestrator from './pages/orchestrator/Orchestrator';
import HhhLogin from './pages/hhh/HhhLogin';
import Triggers from './pages/triggers/Triggers';
import ReferenceData from './pages/reference/ReferenceData';
import Orders from './pages/orders/Orders';

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
        <div className="text-xs font-semibold text-slate-400 px-3 py-1 uppercase tracking-wider">HHH Workflow</div>
        {navItem('/triggers', <Zap size={16} />, 'Trigger', true)}
        {navItem('/builder/workflows', <GitBranch size={16} />, 'Workflow', true)}
        {navItem('/orchestrator', <Activity size={16} />, 'Orchestrator', true)}
        {navItem('/orders', <ClipboardList size={16} />, 'Orders', true)}
        {navItem('/reference-data', <Database size={16} />, 'Reference Data', true)}
        {navItem('/worker', <Inbox size={16} />, 'Work Buckets', true)}
      </nav>

      <div className="p-3 border-t border-slate-100 space-y-1">
        <a href="/worker" target="_blank" rel="noreferrer"
          className="flex items-center gap-2 px-3 py-2 text-xs text-violet-600 hover:bg-violet-50 rounded-lg font-medium transition-colors">
          <Inbox size={13} />
          <span>Open Worker UI</span>
        </a>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const location = useLocation();
  const standalone = location.pathname.startsWith('/hhh-login');

  return (
    <div className="flex min-h-screen bg-slate-50">
      {!standalone && <Sidebar />}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/triggers" replace />} />
          <Route path="/triggers" element={<Triggers />} />
          <Route path="/builder/workflows" element={<WorkflowList />} />
          <Route path="/builder/create" element={<Navigate to="/builder/workflows" replace />} />
          <Route path="/orchestrator" element={<Orchestrator />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/reference-data" element={<ReferenceData />} />
          <Route path="/worker" element={<UserSelect />} />
          <Route path="/worker/bucket/:userId" element={<WorkBucket />} />
          <Route path="/hhh-login" element={<HhhLogin />} />
        </Routes>
      </main>
    </div>
  );
}
