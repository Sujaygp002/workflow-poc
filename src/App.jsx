import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Activity, Building2, GitBranch, Inbox, LogOut, Network, UserRound, Users } from 'lucide-react';
import WorkflowList from './pages/builder/WorkflowList';
import Orchestrator from './pages/orchestrator/Orchestrator';
import HhhLogin from './pages/hhh/HhhLogin';
import PgLogin from './pages/pg/PgLogin';
import NetworkMap from './pages/map/NetworkMap';
import Employees from './pages/employees/Employees';
import Entity from './pages/entity/Entity';
import ExternalUsers from './pages/external/ExternalUsers';
import WorkerPortal from './pages/worker/WorkerPortal';
import CommandCenterLogin from './pages/CommandCenterLogin';

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
          <span className="font-bold text-slate-800 text-sm">Command Center</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItem('/builder/workflows', <GitBranch size={16} />, 'Workflow', true)}
        {navItem('/orchestrator', <Activity size={16} />, 'Orchestrator', true)}
        {navItem('/map', <Network size={16} />, 'Coverage Map', true)}
        {navItem('/employees', <Users size={16} />, 'Employees', true)}
        {navItem('/entity', <Building2 size={16} />, 'Entity', true)}
        {navItem('/external-users', <UserRound size={16} />, 'External Users', true)}
      </nav>

      <div className="p-3 border-t border-slate-100 space-y-1">
        <a href="/worker" target="_blank" rel="noreferrer"
          className="flex items-center gap-2 px-3 py-2 text-xs text-violet-600 hover:bg-violet-50 rounded-lg font-medium transition-colors">
          <Inbox size={13} />
          <span>Open Worker Portal</span>
        </a>
        <SignOutButton />
      </div>
    </aside>
  );
}

function SignOutButton() {
  const navigate = useNavigate();
  function handleSignOut() {
    sessionStorage.removeItem('cc_admin_token');
    navigate('/login', { replace: true });
  }
  return (
    <button
      onClick={handleSignOut}
      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-500 hover:bg-slate-100 rounded-lg font-medium transition-colors"
    >
      <LogOut size={13} />
      <span>Sign out</span>
    </button>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function RequireAuth({ children }) {
  const location = useLocation();
  const token = sessionStorage.getItem('cc_admin_token');
  if (!token) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function AppShell() {
  const location = useLocation();
  const standalone = location.pathname.startsWith('/hhh-login')
    || location.pathname.startsWith('/pg-login')
    || location.pathname.startsWith('/worker')
    || location.pathname.startsWith('/login');

  return (
    <div className="flex min-h-screen bg-slate-50">
      {!standalone && <Sidebar />}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <Routes>
          <Route path="/login" element={<CommandCenterLogin />} />
          <Route path="/worker" element={<WorkerPortal />} />
          <Route path="/hhh-login" element={<HhhLogin />} />
          <Route path="/pg-login" element={<PgLogin />} />
          <Route path="/" element={<RequireAuth><Navigate to="/builder/workflows" replace /></RequireAuth>} />
          <Route path="/builder/workflows" element={<RequireAuth><WorkflowList /></RequireAuth>} />
          <Route path="/builder/create" element={<RequireAuth><Navigate to="/builder/workflows" replace /></RequireAuth>} />
          <Route path="/orchestrator" element={<RequireAuth><Orchestrator /></RequireAuth>} />
          <Route path="/map" element={<RequireAuth><NetworkMap /></RequireAuth>} />
          <Route path="/employees" element={<RequireAuth><Employees /></RequireAuth>} />
          <Route path="/entity" element={<RequireAuth><Entity /></RequireAuth>} />
          <Route path="/external-users" element={<RequireAuth><ExternalUsers /></RequireAuth>} />
          <Route path="*" element={<RequireAuth><Navigate to="/builder/workflows" replace /></RequireAuth>} />
        </Routes>
      </main>
    </div>
  );
}
