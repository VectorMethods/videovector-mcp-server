import React, { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { useNavigationType } from 'react-router-dom';

interface TabActivity {
  isActive: boolean;
  portalContainer: HTMLElement | null;
  navigationType?: ReturnType<typeof useNavigationType>;
}

const TabActivityContext = createContext<TabActivity>({ isActive: true, portalContainer: null });

export const useTabActivity = (): TabActivity => useContext(TabActivityContext);

/** Keep a visited tab's portals mounted, but outside the active tab's UI. */
export const TabActivityProvider: React.FC<{
  isActive: boolean;
  navigationType?: TabActivity['navigationType'];
  children: React.ReactNode;
}> = ({ isActive, navigationType, children }) => {
  const [portalContainer] = useState(() => {
    const container = document.createElement('div');
    container.className = 'tab-portal-container';
    return container;
  });
  useLayoutEffect(() => {
    document.body.appendChild(portalContainer);
    return () => { portalContainer.remove(); };
  }, [portalContainer]);
  useLayoutEffect(() => {
    portalContainer.hidden = !isActive;
  }, [isActive, portalContainer]);
  const value = useMemo(() => ({ isActive, portalContainer, navigationType }), [isActive, portalContainer, navigationType]);
  return <TabActivityContext.Provider value={value}>{children}</TabActivityContext.Provider>;
};
