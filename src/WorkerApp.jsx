import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import UserSelect from './pages/workbucket/UserSelect';
import WorkBucket from './pages/workbucket/WorkBucket';

export default function WorkerApp() {
  return (
    <BrowserRouter basename={`${import.meta.env.BASE_URL}worker.html`}>
      <Routes>
        <Route path="/" element={<UserSelect />} />
        <Route path="/bucket/:userId" element={<WorkBucket />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
