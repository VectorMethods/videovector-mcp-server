import { useEffect, useState } from 'react';

const getInitialVisibility = (): boolean => {
  if (typeof document === 'undefined') {
    return true;
  }
  return !document.hidden;
};

export const usePageVisibility = (): boolean => {
  const [isPageVisible, setIsPageVisible] = useState<boolean>(getInitialVisibility);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isPageVisible;
};
