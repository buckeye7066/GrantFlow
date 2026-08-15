import { createBrowserRouter, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { Loading } from './components/Loading';

const Onboarding = lazy(() => import('../routes/Onboarding'));
const Discover = lazy(() => import('../routes/Discover'));
const OpportunityDetail = lazy(() => import('../routes/OpportunityDetail'));
const Matches = lazy(() => import('../routes/Matches'));
const FunderProfile = lazy(() => import('../routes/FunderProfile'));
const Applications = lazy(() => import('../routes/Applications'));
const ApplicationDetail = lazy(() => import('../routes/ApplicationDetail'));
const PostAward = lazy(() => import('../routes/PostAward'));
const Knowledge = lazy(() => import('../routes/Knowledge'));
const AdminConnectors = lazy(() => import('../routes/admin/Connectors'));
const AdminUsers = lazy(() => import('../routes/admin/Users'));
const AdminQueues = lazy(() => import('../routes/admin/Queues'));

const wrap = (el: React.ReactNode) => (
  <Suspense fallback={<Loading />}>
    {el}
  </Suspense>
);

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/discover" replace /> },
  { path: '/onboarding', element: wrap(<Onboarding />) },
  { path: '/discover', element: wrap(<Discover />) },
  { path: '/opportunities/:id', element: wrap(<OpportunityDetail />) },
  { path: '/matches', element: wrap(<Matches />) },
  { path: '/funders/:id', element: wrap(<FunderProfile />) },
  { path: '/applications', element: wrap(<Applications />) },
  { path: '/applications/:id', element: wrap(<ApplicationDetail />) },
  { path: '/post-award/:id', element: wrap(<PostAward />) },
  { path: '/knowledge', element: wrap(<Knowledge />) },
  { path: '/admin/connectors', element: wrap(<AdminConnectors />) },
  { path: '/admin/users', element: wrap(<AdminUsers />) },
  { path: '/admin/queues', element: wrap(<AdminQueues />) },
  { path: '*', element: <Navigate to="/discover" replace /> },
]);
