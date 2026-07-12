import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { GitBranch, LogIn } from 'lucide-react';

export default function CommandCenterLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const from = location.state?.from || '/builder/workflows';

  function handleSubmit(e) {
    e.preventDefault();
    if (username === 'test123' && password === 'test123') {
      sessionStorage.setItem('cc_admin_token', 'demo');
      navigate(from, { replace: true });
    } else {
      setError('Invalid username or password. Please try again.');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="px-8 pt-8 pb-6 border-b border-slate-100 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-violet-600 mb-4">
              <GitBranch size={22} className="text-white" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Command Center</h1>
            <p className="text-sm text-slate-500 mt-1">Sign in to continue</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-8 py-6 space-y-4">
            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-600 uppercase tracking-wide">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={e => { setUsername(e.target.value); setError(''); }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="Enter username"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-600 uppercase tracking-wide">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError(''); }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="Enter password"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 text-white font-medium text-sm py-2.5 rounded-lg transition-colors mt-2"
            >
              <LogIn size={15} />
              Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
