import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { PreviewGrantItem } from '../services/api';
import { usePassiveApiActivity } from '../hooks/usePassiveApiActivity';
import { useTabActivity } from '../contexts/TabActivityContext';
import {
  getPreviewGrantProjectionKey,
  PreviewGrantProjection,
  usePreviewGrants,
} from '../contexts/PreviewGrantContext';
import {
  getGcsV4SignedMediaExpiryMs,
  GRANTED_MEDIA_EXPIRY_SKEW_MS,
  normalizeGrantedMediaUrl,
} from '../utils/mediaSources';
import './GrantedPreviewImage.css';

/** Refreshes detail-view grants at their exact signed-URL boundary. */
export const useGrantedMediaExpiryRefresh = (
  mediaUrls: ReadonlyArray<string | null | undefined>,
  refreshGrant: () => void | Promise<void>,
): void => {
  const canObserve = usePassiveApiActivity();
  const refreshRef = useRef(refreshGrant);
  refreshRef.current = refreshGrant;
  const lastTriggeredSignatureRef = useRef<string | null>(null);
  const expiringUrls = Array.from(new Set(mediaUrls.flatMap((value) => {
    const normalized = normalizeGrantedMediaUrl(value);
    const expiresAt = getGcsV4SignedMediaExpiryMs(normalized);
    return normalized && expiresAt !== null ? [`${expiresAt}:${normalized}`] : [];
  }))).sort();
  const expirySignature = expiringUrls.join('|');
  const earliestExpiryMs = expiringUrls.reduce<number | null>((earliest, entry) => {
    const separator = entry.indexOf(':');
    const expiresAt = Number(entry.slice(0, separator));
    if (!Number.isFinite(expiresAt)) return earliest;
    return earliest === null ? expiresAt : Math.min(earliest, expiresAt);
  }, null);

  useEffect(() => {
    if (!canObserve || !expirySignature || earliestExpiryMs === null) return undefined;
    let disposed = false;
    const refreshAtMs = earliestExpiryMs - GRANTED_MEDIA_EXPIRY_SKEW_MS;
    const triggerIfDue = () => {
      if (
        disposed
        || Date.now() < refreshAtMs
        || lastTriggeredSignatureRef.current === expirySignature
      ) return;
      lastTriggeredSignatureRef.current = expirySignature;
      void Promise.resolve(refreshRef.current()).catch((error) => {
        console.error('Failed to refresh the media grant:', error);
      });
    };
    const timer = window.setTimeout(triggerIfDue, Math.max(0, refreshAtMs - Date.now()));
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') triggerIfDue();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    triggerIfDue();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [canObserve, earliestExpiryMs, expirySignature]);
};

type PreviewViewportRegistration = (
  element: Element,
  onNearViewportChange: (isNear: boolean) => void,
) => () => void;

const PreviewViewportContext = createContext<PreviewViewportRegistration | null>(null);

/** Owns exactly one observer for all tile shells in one mounted gallery grid. */
export const PreviewViewportProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isActive } = useTabActivity();
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const observerRef = useRef<IntersectionObserver | null>(null);
  const listenersRef = useRef(new Map<Element, (isNear: boolean) => void>());

  const register = useCallback<PreviewViewportRegistration>((element, listener) => {
    listenersRef.current.set(element, listener);
    if (typeof IntersectionObserver === 'undefined' && isActiveRef.current) {
      listener(true);
    } else {
      observerRef.current?.observe(element);
    }
    return () => {
      observerRef.current?.unobserve(element);
      listenersRef.current.delete(element);
    };
  }, []);

  useEffect(() => {
    // Hiding a retained tab is not scrolling its tiles out of view. Keep each
    // registration and its last visibility until the active observer resumes.
    if (!isActive) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      listenersRef.current.forEach((listener) => listener(true));
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!isActiveRef.current || observerRef.current !== observer) return;
      entries.forEach((entry) => {
        listenersRef.current.get(entry.target)?.(entry.isIntersecting);
      });
    }, {
      root: null,
      rootMargin: '100% 100%',
      threshold: 0,
    });
    observerRef.current = observer;
    listenersRef.current.forEach((_listener, element) => observer.observe(element));
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [isActive]);

  return (
    <PreviewViewportContext.Provider value={register}>
      {children}
    </PreviewViewportContext.Provider>
  );
};

export const useIsNearPreviewViewport = <ElementType extends Element>(
  elementRef: React.RefObject<ElementType>,
): boolean => {
  const register = useContext(PreviewViewportContext);
  const [isNear, setIsNear] = useState(
    register === null || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!register || !element) {
      setIsNear(true);
      return undefined;
    }
    setIsNear(false);
    return register(element, setIsNear);
  }, [elementRef, register]);

  return isNear;
};

/** Fixed grid shell that mounts its child component only inside the shared overscan. */
export const DeferredPreviewTile: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const isNearViewport = useIsNearPreviewViewport(shellRef);
  return (
    <div
      ref={shellRef}
      className={`preview-viewport-tile-shell ${className}`.trim()}
    >
      {isNearViewport
        ? children
        : <div className="preview-viewport-tile-placeholder" aria-hidden="true" />}
    </div>
  );
};

type PreviewGrantState =
  | { key: null; status: 'idle'; grant: null }
  | { key: string; status: 'loading'; grant: null }
  | { key: string; status: 'error'; grant: null }
  | { key: string; status: 'ready'; grant: PreviewGrantItem | null };

const useTilePreviewGrant = (
  projection: PreviewGrantProjection | null | undefined,
): PreviewGrantState => {
  const canObserve = usePassiveApiActivity();
  const requestPreviewGrant = usePreviewGrants();
  const key = projection ? getPreviewGrantProjectionKey(projection) : null;
  const projectionRef = useRef<{
    key: string | null;
    projection: PreviewGrantProjection | null | undefined;
  }>({ key, projection });
  if (projectionRef.current.key !== key) {
    projectionRef.current = { key, projection };
  }
  const [state, setState] = useState<PreviewGrantState>({
    key: null,
    status: 'idle',
    grant: null,
  });

  useEffect(() => {
    if (!canObserve) return undefined;
    const activeProjection = projectionRef.current.projection;
    if (!activeProjection || !key) {
      setState({ key: null, status: 'idle', grant: null });
      return undefined;
    }
    let disposed = false;
    let expiryTimer: number | null = null;

    const load = (forceRefresh: boolean) => {
      setState((previous) => previous.key === key && previous.status === 'ready'
        ? previous
        : { key, status: 'loading', grant: null });
      void requestPreviewGrant(activeProjection, { forceRefresh }).then((grant) => {
        if (disposed) return;
        setState({ key, status: 'ready', grant });
        const expiresAtMs = grant?.grant_expires_at
          ? Date.parse(grant.grant_expires_at)
          : Number.NaN;
        if (Number.isFinite(expiresAtMs)) {
          expiryTimer = window.setTimeout(
            () => load(true),
            Math.max(0, expiresAtMs - GRANTED_MEDIA_EXPIRY_SKEW_MS - Date.now()),
          );
        }
      }).catch((error) => {
        if (disposed) return;
        console.error('Failed to acquire tile preview grant:', error);
        setState({ key, status: 'error', grant: null });
      });
    };

    load(false);
    return () => {
      disposed = true;
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    };
  }, [canObserve, key, requestPreviewGrant]);

  if (state.key !== key) {
    return key
      ? { key, status: 'loading', grant: null }
      : { key: null, status: 'idle', grant: null };
  }
  return state;
};

interface GrantedPreviewImageProps {
  posterUrl?: string | null;
  animatedUrl?: string | null;
  projection?: PreviewGrantProjection | null;
  alt: string;
  className: string;
  containerClassName?: string;
  placeholder?: React.ReactNode;
  children?: React.ReactNode;
  /** Cards and tiles pass this explicitly so their outer boundary owns engagement. */
  engaged?: boolean;
  containerTabIndex?: number;
}

/**
 * Tile media mounts once, in the DOM. Posters load lazily; the animated WebP
 * exists only while engaged and replaces the poster only after that exact
 * element has loaded and decoded.
 */
export const GrantedPreviewImage: React.FC<GrantedPreviewImageProps> = ({
  posterUrl,
  animatedUrl,
  projection,
  alt,
  className,
  containerClassName,
  placeholder,
  children,
  engaged,
  containerTabIndex,
}) => {
  const grantState = useTilePreviewGrant(projection);
  const poster = normalizeGrantedMediaUrl(
    projection === undefined ? posterUrl : grantState.grant?.thumbnail_uri,
  );
  const animation = normalizeGrantedMediaUrl(
    projection === undefined ? animatedUrl : grantState.grant?.gif_uri,
  );
  const [selfEngaged, setSelfEngaged] = useState(false);
  const isEngaged = engaged ?? selfEngaged;
  const [posterReady, setPosterReady] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [animationReady, setAnimationReady] = useState(false);
  const [animationFailed, setAnimationFailed] = useState(false);
  const animationGenerationRef = useRef(0);

  useEffect(() => {
    setPosterReady(false);
    setPosterFailed(false);
  }, [poster]);

  useEffect(() => {
    animationGenerationRef.current += 1;
    setAnimationReady(false);
    setAnimationFailed(false);
  }, [animation]);

  useEffect(() => {
    animationGenerationRef.current += 1;
    if (!isEngaged) setAnimationReady(false);
  }, [isEngaged]);

  const handleAnimationLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const generation = animationGenerationRef.current;
    let decodePromise: Promise<void>;
    try {
      decodePromise = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
    } catch {
      setAnimationFailed(true);
      return;
    }
    void decodePromise.then(() => {
      if (animationGenerationRef.current !== generation) return;
      setAnimationReady(true);
    }).catch(() => {
      if (animationGenerationRef.current !== generation) return;
      setAnimationFailed(true);
    });
  }, []);

  const showPlaceholder = (
    projection === undefined || projection === null || grantState.status === 'ready'
  ) && (!poster || posterFailed);
  const content = (
    <>
      {showPlaceholder && placeholder}
      {grantState.status === 'error' && (
        <span className="preview-placeholder" role="status">Preview unavailable</span>
      )}
      {poster && !posterFailed && (
        <img
          src={poster}
          alt={alt}
          className={`${className} granted-preview-image__asset granted-preview-image__poster ${posterReady ? 'granted-preview-image__poster--ready' : ''}`}
          loading="lazy"
          decoding="async"
          onLoad={() => setPosterReady(true)}
          onError={() => setPosterFailed(true)}
        />
      )}
      {isEngaged && animation && !animationFailed && (
        <img
          src={animation}
          alt=""
          aria-hidden="true"
          className={`${className} granted-preview-image__asset granted-preview-image__animation ${animationReady ? 'granted-preview-image__animation--ready' : ''}`}
          loading="eager"
          decoding="async"
          onLoad={handleAnimationLoad}
          onError={() => setAnimationFailed(true)}
        />
      )}
      {children}
    </>
  );

  if (!containerClassName) return content;
  const selfOwnsEngagement = engaged === undefined;
  return (
    <div
      className={`${containerClassName} granted-preview-image__container ${animationReady && isEngaged ? 'granted-preview-image__container--animation-ready' : ''}`}
      tabIndex={containerTabIndex}
      aria-busy={projection !== undefined && grantState.status === 'loading'}
      onPointerEnter={selfOwnsEngagement ? () => setSelfEngaged(true) : undefined}
      onPointerLeave={selfOwnsEngagement ? () => setSelfEngaged(false) : undefined}
      onFocus={selfOwnsEngagement ? () => setSelfEngaged(true) : undefined}
      onBlur={selfOwnsEngagement ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelfEngaged(false);
      } : undefined}
    >
      {content}
    </div>
  );
};

export default GrantedPreviewImage;
