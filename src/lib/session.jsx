import React, { useCallback, useEffect, useMemo, useReducer } from 'react';
import {
  SESSION_ACTIONS,
  SessionContext,
  initialSessionState,
  persistSession,
  readStoredSession,
  sessionReducer,
} from './session.js';

export function SessionProvider({ children, initialSession }) {
  const [session, dispatch] = useReducer(
    sessionReducer,
    initialSession ? { ...initialSessionState, ...initialSession, hydrated: true } : initialSessionState,
  );

  useEffect(() => {
    if (initialSession) {
      dispatch({ type: SESSION_ACTIONS.HYDRATE, payload: initialSession });
      return;
    }

    dispatch({ type: SESSION_ACTIONS.HYDRATE, payload: readStoredSession() });
  }, [initialSession]);

  useEffect(() => {
    if (session.hydrated) {
      persistSession(session);
    }
  }, [session]);

  const login = useCallback((payload) => {
    dispatch({ type: SESSION_ACTIONS.LOGIN, payload });
  }, []);

  const logout = useCallback(() => {
    dispatch({ type: SESSION_ACTIONS.LOGOUT });
  }, []);

  const setUser = useCallback((user) => {
    dispatch({ type: SESSION_ACTIONS.SET_USER, payload: user });
  }, []);

  const setToken = useCallback((token) => {
    dispatch({ type: SESSION_ACTIONS.SET_TOKEN, payload: token });
  }, []);

  const setOrganization = useCallback((organization) => {
    dispatch({ type: SESSION_ACTIONS.SET_ORGANIZATION, payload: organization });
  }, []);

  const setRoles = useCallback((roles) => {
    dispatch({ type: SESSION_ACTIONS.SET_ROLES, payload: roles });
  }, []);

  const value = useMemo(
    () => ({
      ...session,
      session,
      dispatch,
      login,
      logout,
      setUser,
      setToken,
      setOrganization,
      setRoles,
    }),
    [login, logout, session, setOrganization, setRoles, setToken, setUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export default SessionProvider;
