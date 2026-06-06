const colors = {
  pending: 'bg-amber-100 text-amber-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  click: 'bg-violet-100 text-violet-700',
  schedule: 'bg-sky-100 text-sky-700',
  action: 'bg-orange-100 text-orange-700',
  task: 'bg-teal-100 text-teal-700',
  workflow: 'bg-indigo-100 text-indigo-700',
  human: 'bg-pink-100 text-pink-700',
  ai: 'bg-purple-100 text-purple-700',
  system: 'bg-slate-100 text-slate-600',
};

export default function Badge({ label, type }) {
  const cls = colors[type] || colors[label?.toLowerCase()] || 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
