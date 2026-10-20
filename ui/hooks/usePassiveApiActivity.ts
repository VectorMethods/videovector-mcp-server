import { useSyncExternalStore } from 'react';
import { useTabActivity } from '../contexts/TabActivityContext';
import { isPassiveApiActivityRecent, subscribePassiveApiActivity } from '../services/passiveApiActivity';
import { usePageVisibility } from './usePageVisibility';

/** Keep mounted state; suspend only automatic reads while nobody is watching. */
export const usePassiveApiActivity = (hasActiveWork = false, enabled = true): boolean => {
  const { isActive } = useTabActivity();
  const visible = usePageVisibility();
  const recentActivity = useSyncExternalStore(subscribePassiveApiActivity, isPassiveApiActivityRecent);
  return enabled && isActive && visible && (recentActivity || hasActiveWork);
};
