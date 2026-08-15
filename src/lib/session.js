import React, { useContext } from 'react';

export const SESSION_STORAGE_KEY = 'grantflow.session';
export const SESSION_TOKEN_STORAGE_KEY = 'grantflow.session.token';

export const SESSION_ACTIONS = Object.freeze({
  HYDRATE: 'HYDRATE',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  SET_USER: 'SET_USER',
  SET_TOKEN: 'SET_TOKEN',
  SET_ORGANIZATION: 'SET_ORGANIZATION',
  SET_ROLES: 'SET_ROLES',
});

export const initialSessionState = Object.freeze({
  user: null,
  token: null,
  organization: null,
  roles: [],
  isAuthenticated: false,
  hydrated: false,
});

export const SessionContext = React.createContext(undefined);

function normalizeSession(session) {
  const nextSession = session && typeof session === 'object' ? session : {};
  const token = nextSession.token || null;
  const user = nextSession.user || null;

  return {
    ...initialSessionState,
    ...nextSession,
    token,
    user,
    organization: nextSession.organization || null,
    roles: Array.isArray(nextSession.roles) ? nextSession.roles : [],
    isAuthenticated: Boolean(token || user),
    hydrated: true,
  };
}

export function sessionReducer(state, action) {
  switch (action.type) {
    case SESSION_ACTIONS.HYDRATE:
      return normalizeSession(action.payload);
    case SESSION_ACTIONS.LOGIN:
      return normalizeSession({
        ...state,
        ...action.payload,
        hydrated: true,
      });
    case SESSION_ACTIONS.LOGOUT:
      return {
        ...initialSessionState,
        hydrated: true,
      };
    case SESSION_ACTIONS.SET_USER:
      return normalizeSession({
        ...state,
        user: action.payload || null,
      });
    case SESSION_ACTIONS.SET_TOKEN:
      return normalizeSession({
        ...state,
        token: action.payload || null,
      });
    case SESSION_ACTIONS.SET_ORGANIZATION:
      return normalizeSession({
        ...state,
        organization: action.payload || null,
      });
    case SESSION_ACTIONS.SET_ROLES:
      return normalizeSession({
        ...state,
        roles: Array.isArray(action.payload) ? action.payload : [],
      });
    default:
      return state;
  }
}

export function readStoredSession() {
  if (typeof window === 'undefined') {
    return { ...initialSessionState, hydrated: true };
  }

  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    const token = window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};

    return normalizeSession({
      ...parsed,
      token: parsed.token || token || null,
    });
  } catch {
    return { ...initialSessionState, hydrated: true };
  }
}

export function persistSession(session) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!session || !session.isAuthenticated) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));

    if (session.token) {
      window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, session.token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage failures should not break the UI session state.
  }
}

export function useSession() {
  const context = useContext(SessionContext);

  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider.');
  }

  return context;
}

export function useCurrentUser() {
  return useSession().user;
}

export function useIsAuthenticated() {
  return useSession().isAuthenticated;
}

export function hasRole(session, role) {
  if (!session || !Array.isArray(session.roles)) {
    return false;
  }

  return session.roles.includes(role);
}
