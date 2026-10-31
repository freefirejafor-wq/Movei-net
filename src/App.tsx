import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  BookOpen,
  Bookmark,
  Calendar,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Film,
  Flame,
  FolderHeart,
  Home,
  Layers,
  Loader2,
  Megaphone,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
  Trophy,
  Tv,
  Upload,
  User,
  WifiOff,
  X,
} from 'lucide-react';
import {
  ALL_CATEGORIES,
  CURATED_COLLECTION_CARDS,
  INITIAL_FALLBACK_MOVIES,
  TOP_10_THIS_WEEK_ITEMS,
  UPCOMING_RELEASES,
} from './data/categories';
import type {
  CategoryOption,
  EpisodeItem,
  GlobalMovieNotification,
  MovieCardItem,
  StreamSource,
  UserMovieRequest,
  WatchlistFolder,
  WatchProgressItem,
} from './types/cinema';
import { usePWAInstall } from './hooks/usePWAInstall';
import { MovieDetailModal } from './components/MovieDetailModal';
import { PWAInstallModal } from './components/PWAInstallModal';
import { MovieRequestModal } from './components/MovieRequestModal';
import { prefetchMovieDetails, universalApiFetch } from './services/liveClientEngine';
import {
  getItemMinutesAgo,
  isUploadedWithinMinutes,
  normalizeMovieCardItem,
  normalizeMovieCardList,
  sortItemsByHighRating,
  sortItemsByHotAndHype,
  sortItemsByRecentUpload,
} from './utils/timeAgo';

const WATCHLIST_STORAGE_KEY = 'cp_iphone_watchlist_v2';
const CONTINUE_STORAGE_KEY = 'cp_iphone_continue_v2';
const RECENT_SEARCH_STORAGE_KEY = 'cp_recent_searches_v1';
const ACTIVE_NODE_STORAGE_KEY = 'cp_active_node_v1';
const READ_NOTIFS_STORAGE_KEY = 'cp_read_notifications_v1';
const PUSH_ENABLED_STORAGE_KEY = 'cp_push_alerts_enabled_v1';

function parseViewsCount(viewsStr: string): number {
  if (!viewsStr) return 0;
  const clean = viewsStr.toUpperCase().replace(/[^0-9.KM]/g, '');
  const num = parseFloat(clean) || 0;
  if (clean.includes('M')) return num * 1_000_000;
  if (clean.includes('K')) return num * 1_000;
  return num;
}

function formatResumeTime(sec?: number): string {
  if (!sec || sec < 5) return 'Resume';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatShortLanguage(lang: string): string {
  const up = (lang || '').toUpperCase();
  if (up.includes('BANGLA') || up.includes('BENGALI')) return 'Bengali';
  if (up.includes('HINDI')) return 'Hindi';
  if (up.includes('TAMIL')) return 'Tamil';
  if (up.includes('TELUGU')) return 'Telugu';
  if (up.includes('JAP')) return 'Anime';
  if (up.includes('KOR')) return 'Korean';
  if (up.includes('DUAL') || up.includes('MULTI')) return 'Dual Audio';
  return 'English';
}

export default function App() {
  const { isInstallable, isInstalled, isIOS, isOnline, install } = usePWAInstall();

  // Navigation & View Mode
  const [activeTab, setActiveTab] = useState<'browse' | 'categories' | 'watchlist' | 'me'>('browse');
  const [currentCategory, setCurrentCategory] = useState<CategoryOption>(ALL_CATEGORIES[0]);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [maxPage, setMaxPage] = useState<number>(520);
  const [jumpPageInput, setJumpPageInput] = useState<string>('');

  // Search & Instant Live Suggestions
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [submittedSearch, setSubmittedSearch] = useState<string>('');
  const [suggestions, setSuggestions] = useState<MovieCardItem[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState<boolean>(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_SEARCH_STORAGE_KEY);
      return raw ? JSON.parse(raw) : ['Bohurupi', 'Mirzapur', 'One Piece', 'Korean Drama'];
    } catch {
      return ['Bohurupi', 'Mirzapur', 'One Piece'];
    }
  });
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // Advanced Filters & Sorting (Default: HOT_HYPE so popular, high-rating, dhamaka items stay on top)
  const [audioFilter, setAudioFilter] = useState<'ALL' | 'BANGLA' | 'HINDI' | 'DUAL' | 'SUB'>('ALL');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | '4K' | '1080P' | 'WEBDL' | 'HDTC'>('ALL');
  const [yearFilter, setYearFilter] = useState<'ALL' | '2026' | '2025' | 'OLDER'>('ALL');
  const [sortBy, setSortBy] = useState<'HOT_HYPE' | 'LATEST' | 'RATING' | 'VIEWS' | 'TITLE'>('HOT_HYPE');

  // Anonymized Server Node Selection
  const [activeNodeId, setActiveNodeId] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_NODE_STORAGE_KEY) || 'node-alpha';
    } catch {
      return 'node-alpha';
    }
  });

  // Catalog Items State
  const [items, setItems] = useState<MovieCardItem[]>(() =>
    sortItemsByHotAndHype(INITIAL_FALLBACK_MOVIES['/'])
  );
  const [loadingCatalog, setLoadingCatalog] = useState<boolean>(false);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  // Modals, Mini-Player & Entry Splash Screen State
  const [showSplashScreen, setShowSplashScreen] = useState<boolean>(true);
  const [selectedMovie, setSelectedMovie] = useState<MovieCardItem | null>(null);
  const [isMiniPlayer, setIsMiniPlayer] = useState<boolean>(false);
  const [liveClockNow, setLiveClockNow] = useState<number>(() => Date.now());
  const [showInstallModal, setShowInstallModal] = useState<boolean>(false);
  const [showRequestModal, setShowRequestModal] = useState<boolean>(false);
  const [showLast24hModal, setShowLast24hModal] = useState<boolean>(false);
  const [last24hFilter, setLast24hFilter] = useState<'ALL' | 'MOVIE' | 'SERIES' | 'ANIME'>('ALL');
  const [requestPrefillTitle, setRequestPrefillTitle] = useState<string>('');
  const [requestPrefillType, setRequestPrefillType] = useState<UserMovieRequest['type']>('MOVIE');

  // Silent Automatic Phone OS Push Notification State (No in-app popup clutter)
  const [serverNotifications, setServerNotifications] = useState<GlobalMovieNotification[]>([]);
  const [pushedPhoneNotifIds, setPushedPhoneNotifIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(READ_NOTIFS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const pushedSetRef = useRef<Set<string>>(new Set(pushedPhoneNotifIds));

  // Tick live clock every 20 seconds so upload times ("4 mins ago" -> "5 mins ago" -> "1 hour ago") update dynamically!
  useEffect(() => {
    const clockTimer = window.setInterval(() => {
      setLiveClockNow(Date.now());
    }, 20_000);
    return () => window.clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowSplashScreen(false);
    }, 1350);
    return () => window.clearTimeout(timer);
  }, []);

  // Watchlist & Custom Folders + Backup/Restore
  const [watchlistFolderTab, setWatchlistFolderTab] = useState<'all' | WatchlistFolder>('all');
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const [watchlist, setWatchlist] = useState<MovieCardItem[]>(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [continueWatching, setContinueWatching] = useState<WatchProgressItem[]>(() => {
    try {
      const raw = localStorage.getItem(CONTINUE_STORAGE_KEY);
      const parsed: WatchProgressItem[] = raw ? JSON.parse(raw) : [];
      return parsed.map((entry) => ({
        ...entry,
        movie: {
          ...entry.movie,
          uploadedAtMs: undefined,
        },
      }));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
    } catch {
      // ignore
    }
  }, [watchlist]);

  useEffect(() => {
    try {
      localStorage.setItem(CONTINUE_STORAGE_KEY, JSON.stringify(continueWatching));
    } catch {
      // ignore
    }
  }, [continueWatching]);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_SEARCH_STORAGE_KEY, JSON.stringify(recentSearches));
    } catch {
      // ignore
    }
  }, [recentSearches]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_NODE_STORAGE_KEY, activeNodeId);
    } catch {
      // ignore
    }
  }, [activeNodeId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced Instant Live Search Suggestions (Starts from 1st character!)
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 1) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }

    // Immediate local match from loaded items so user sees results in 0ms while typing
    const lower = q.toLowerCase();
    const localInstant = items
      .filter((item) => item.title.toLowerCase().includes(lower))
      .slice(0, 6);
    if (localInstant.length > 0) {
      setSuggestions(localInstant);
    }

    if (q.length < 2) {
      setLoadingSuggestions(false);
      return;
    }

    let cancelled = false;
    setLoadingSuggestions(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, node: activeNodeId });
        const data = await universalApiFetch(`/api/suggest?${params.toString()}`);
        if (!cancelled && data && Array.isArray(data.items) && data.items.length > 0) {
          setSuggestions(data.items);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingSuggestions(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, activeNodeId, items]);

  // Fetch Live Catalog from Express Server or GitHub Live Engine (18+ Always Unlocked + Live Auto-Sync)
  const fetchCatalog = useCallback(
    async (path: string, page: number, query: string, nodeId: string, forceRefresh = false, silent = false) => {
      if (!silent) setLoadingCatalog(true);
      try {
        const params = new URLSearchParams({
          path,
          page: String(page),
          q: query,
          node: nodeId,
          ...(forceRefresh ? { refresh: '1' } : {}),
        });
        const data = await universalApiFetch(`/api/catalog?${params.toString()}`);
        if (data && Array.isArray(data.items) && data.items.length > 0) {
          setItems(normalizeMovieCardList(data.items));
          if (data.maxPage) setMaxPage(data.maxPage);
          if (!silent) setLoadingCatalog(false);
          return;
        }
      } catch {
        // Keep fallback items if offline
      } finally {
        if (!silent) setLoadingCatalog(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId);
  }, [currentCategory.path, currentPage, submittedSearch, activeNodeId, fetchCatalog]);

  // Automatic Real-Time Background Sync for New Movies & Episodes (Every 30s + App Foreground Wake)
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && activeTab === 'browse') {
        setLiveClockNow(Date.now());
        fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId, true, true);
      }
    }, 30_000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeTab === 'browse') {
        setLiveClockNow(Date.now());
        fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId, false, true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeTab, currentCategory.path, currentPage, submittedSearch, activeNodeId, fetchCatalog]);

  // Prevent background page rubber-banding / scrolling when Fullscreen Movie Player or Modals are open
  // (Keep scrolling UNLOCKED when player is minimized to Floating Mini Player!)
  useEffect(() => {
    if ((selectedMovie && !isMiniPlayer) || showInstallModal || showRequestModal || showLast24hModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedMovie, isMiniPlayer, showInstallModal, showRequestModal, showLast24hModal]);

  useEffect(() => {
    pushedSetRef.current = new Set(pushedPhoneNotifIds);
    try {
      localStorage.setItem(READ_NOTIFS_STORAGE_KEY, JSON.stringify(pushedPhoneNotifIds.slice(-150)));
    } catch {
      // ignore
    }
  }, [pushedPhoneNotifIds]);

  // Register Service Worker (/sw-push.js) & listen for Phone Notification tap to open movie directly
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw-push.js').catch(() => {
      // ignore if main PWA SW is already controlling
    });

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CINEPULSE_OPEN_MOVIE' && event.data.movie) {
        setIsMiniPlayer(false);
        setSelectedMovie(normalizeMovieCardItem(event.data.movie));
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSwMessage);
  }, []);

  // Helper to send Native Phone OS Notification (Status Bar / Lock Screen) — Zero in-app UI clutter
  const sendNativePhoneNotification = useCallback((notif: GlobalMovieNotification) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;

    const deepLinkUrl = `${window.location.origin}${window.location.pathname}?watch=${encodeURIComponent(
      notif.movie.path
    )}&title=${encodeURIComponent(notif.movie.title)}`;

    const options: NotificationOptions & Record<string, any> = {
      body: `${notif.badgeText} • ${notif.subtitleBn}`,
      icon: notif.movie.poster || './pwa-192x192.png',
      image: notif.movie.poster || undefined,
      badge: './pwa-192x192.png',
      tag: notif.id,
      renotify: true,
      vibrate: [180, 80, 180],
      data: {
        url: deepLinkUrl,
        movie: notif.movie,
      },
    };

    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready
          .then((reg) => {
            reg.showNotification(notif.headlineBn, options);
          })
          .catch(() => {
            const n = new Notification(notif.headlineBn, options);
            n.onclick = () => {
              window.focus();
              setIsMiniPlayer(false);
              setSelectedMovie(notif.movie);
              n.close();
            };
          });
      } else {
        const n = new Notification(notif.headlineBn, options);
        n.onclick = () => {
          window.focus();
          setIsMiniPlayer(false);
          setSelectedMovie(notif.movie);
          n.close();
        };
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  // Fetch Global Notifications (New Movie Uploads + Popular High-Rated Movies) from Server & Auto-Poll every 25s
  const fetchGlobalNotifications = useCallback(async () => {
    try {
      const data = await universalApiFetch('/api/notifications');
      if (data && Array.isArray(data.notifications) && data.notifications.length > 0) {
        setServerNotifications(data.notifications);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchGlobalNotifications();
    const timer = window.setInterval(() => {
      fetchGlobalNotifications();
    }, 25_000);
    return () => window.clearInterval(timer);
  }, [fetchGlobalNotifications]);

  // Synthesize complete live notifications list (New Uploads + Top Rated Popular hits)
  const allNotifications = useMemo<GlobalMovieNotification[]>(() => {
    const merged: GlobalMovieNotification[] = [...serverNotifications];
    const seenIds = new Set<string>(merged.map((n) => n.id));
    const seenMovieCat = new Set<string>(merged.map((n) => `${n.category}::${n.movie.path}`));

    const cleanItems = normalizeMovieCardList(
      [...items, ...TOP_10_THIS_WEEK_ITEMS].filter((i) => !i.isAdult),
      liveClockNow
    );
    const recentList = sortItemsByRecentUpload(cleanItems, liveClockNow).slice(0, 10);
    const popularHighRated = sortItemsByHighRating(cleanItems, liveClockNow).slice(0, 10);

    const maxLen = Math.max(recentList.length, popularHighRated.length);
    for (let i = 0; i < maxLen; i++) {
      const newIt = recentList[i];
      if (newIt && !seenMovieCat.has(`NEW_UPLOAD::${newIt.path}`)) {
        const id = `notif-new-${newIt.id}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          seenMovieCat.add(`NEW_UPLOAD::${newIt.path}`);
          const mins = getItemMinutesAgo(newIt, i, liveClockNow);
          const ratingNum = parseFloat(newIt.rating || '8.8') || 8.8;
          const isEp = Boolean(newIt.episodePill);
          merged.push({
            id,
            category: 'NEW_UPLOAD',
            badgeText: isEp ? `নতুন এপিসোড • ${newIt.episodePill}` : 'নতুন মুভি আপলোড 🔥',
            headlineBn: isEp
              ? `নতুন এপিসোড: ${newIt.title}`
              : `নতুন মুভি আপলোড: ${newIt.title}`,
            subtitleBn: `${formatShortLanguage(newIt.language)} • ${newIt.quality || '1080p HD'} • ★ ${ratingNum.toFixed(1)} • ${newIt.timeAgo}`,
            movie: newIt,
            createdAt: Math.max(liveClockNow - mins * 60_000, liveClockNow - 24 * 3600_000),
            ratingScore: ratingNum,
          });
        }
      }

      const popIt = popularHighRated[i];
      if (popIt && !seenMovieCat.has(`TOP_RATED_POPULAR::${popIt.path}`)) {
        const id = `notif-pop-${popIt.id}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          seenMovieCat.add(`TOP_RATED_POPULAR::${popIt.path}`);
          const ratingNum = Math.max(8.5, parseFloat(popIt.rating || '9.2') || 9.2);
          merged.push({
            id,
            category: 'TOP_RATED_POPULAR',
            badgeText: `জনপ্রিয় • রেটিং ★ ${ratingNum.toFixed(1)}`,
            headlineBn: `জনপ্রিয় ও হাই-রেটিং মুভি: ${popIt.title}`,
            subtitleBn: `রেটিং ★ ${ratingNum.toFixed(1)}/10 • ${popIt.views || '310K+'} ভিউ • ${formatShortLanguage(popIt.language)} • ${popIt.quality || 'Full HD'}`,
            movie: popIt,
            createdAt: liveClockNow - (i + 1) * 180_000,
            ratingScore: ratingNum,
          });
        }
      }
    }

    return merged.slice(0, 30);
  }, [serverNotifications, items, liveClockNow]);

  // Automatically request Phone OS Notification permission on first user touch & deliver unseen notifications directly to Phone Status Bar!
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const deliverNextUnseenPhoneNotification = () => {
      if (Notification.permission !== 'granted') return;
      const nextUnseen = allNotifications.find((n) => !pushedSetRef.current.has(n.id));
      if (nextUnseen) {
        pushedSetRef.current.add(nextUnseen.id);
        setPushedPhoneNotifIds((prev) =>
          prev.includes(nextUnseen.id) ? prev : [...prev, nextUnseen.id]
        );
        sendNativePhoneNotification(nextUnseen);
      }
    };

    if (Notification.permission === 'granted') {
      const timer = window.setTimeout(deliverNextUnseenPhoneNotification, 1800);
      return () => window.clearTimeout(timer);
    }

    if (Notification.permission === 'default') {
      const requestOnFirstGesture = () => {
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') {
              deliverNextUnseenPhoneNotification();
            }
          })
          .catch(() => {});
        window.removeEventListener('pointerdown', requestOnFirstGesture);
        window.removeEventListener('keydown', requestOnFirstGesture);
      };
      window.addEventListener('pointerdown', requestOnFirstGesture, { once: true, passive: true });
      window.addEventListener('keydown', requestOnFirstGesture, { once: true, passive: true });
      return () => {
        window.removeEventListener('pointerdown', requestOnFirstGesture);
        window.removeEventListener('keydown', requestOnFirstGesture);
      };
    }
  }, [allNotifications, sendNativePhoneNotification]);

  // Support Direct Shared Movie Links (?watch=/path/to/movie&title=...) on App Load
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const watchPath = params.get('watch');
      const watchTitle = params.get('title') || 'Featured Stream';
      if (watchPath) {
        const matched =
          items.find((m) => m.path === watchPath) ||
          TOP_10_THIS_WEEK_ITEMS.find((m) => m.path === watchPath);
        if (matched) {
          setSelectedMovie(matched);
        } else {
          setSelectedMovie({
            id: watchPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
            title: watchTitle,
            url: watchPath,
            path: watchPath,
            poster: '',
            quality: '1080p Full HD',
            views: 'Live',
            language: 'Multi Audio',
            typeBadge: watchPath.includes('/anime') ? 'ANIME' : 'MOVIE',
            timeAgo: 'Shared Link',
            episodePill: '',
            isPinned: false,
            isAdult: false,
          });
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Mobile / Browser Hardware Back Button Support: Minimize player to Floating Mini Player or close modal
  useEffect(() => {
    const anyModalOpen = Boolean(
      (selectedMovie && !isMiniPlayer) || showInstallModal || showRequestModal || showLast24hModal
    );
    if (anyModalOpen) {
      window.history.pushState({ cinepulseModal: true }, '');
    }
    const handlePopState = () => {
      if (selectedMovie && !isMiniPlayer) {
        setIsMiniPlayer(true);
      } else if (showLast24hModal) {
        setShowLast24hModal(false);
      } else if (showRequestModal) {
        setShowRequestModal(false);
      } else if (showInstallModal) {
        setShowInstallModal(false);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedMovie, isMiniPlayer, showInstallModal, showRequestModal, showLast24hModal]);

  const saveRecentSearch = (term: string) => {
    const cleaned = term.trim();
    if (!cleaned) return;
    setRecentSearches((prev) => [cleaned, ...prev.filter((s) => s.toLowerCase() !== cleaned.toLowerCase())].slice(0, 8));
  };

  const handleSelectCategory = (cat: CategoryOption) => {
    setCurrentCategory(cat);
    setCurrentPage(1);
    setSubmittedSearch('');
    setSearchQuery('');
    setAudioFilter('ALL');
    setQualityFilter('ALL');
    setYearFilter('ALL');
    setShowSearchDropdown(false);
    setActiveTab('browse');
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    setSubmittedSearch(trimmed);
    if (trimmed) saveRecentSearch(trimmed);
    setCurrentPage(1);
    setShowSearchDropdown(false);
    setActiveTab('browse');
  };

  const handleTriggerActorSearch = (actorName: string) => {
    setSearchQuery(actorName);
    setSubmittedSearch(actorName);
    saveRecentSearch(actorName);
    setCurrentPage(1);
    setActiveTab('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePageChange = (newPage: number) => {
    const clamped = Math.max(1, Math.min(maxPage, newPage));
    setCurrentPage(clamped);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleJumpPage = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(jumpPageInput, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      handlePageChange(parsed);
      setJumpPageInput('');
    }
  };

  const handleToggleWatchlist = useCallback((movie: MovieCardItem, folder: WatchlistFolder = 'favorites') => {
    setWatchlist((prev) => {
      const existing = prev.find((m) => m.path === movie.path || m.title === movie.title);
      if (existing) {
        if (existing.folder !== folder) {
          return prev.map((m) =>
            m.path === movie.path || m.title === movie.title ? { ...m, folder } : m
          );
        }
        return prev.filter((m) => m.path !== movie.path && m.title !== movie.title);
      }
      const defaultFolder: WatchlistFolder =
        movie.typeBadge === 'ANIME' || movie.typeBadge === 'SERIES' || movie.typeBadge === 'DRAMA'
          ? 'anime_series'
          : folder;
      return [{ ...movie, folder: defaultFolder }, ...prev];
    });
  }, []);

  const handleRecordWatchProgress = useCallback(
    (
      movie: MovieCardItem,
      episode?: EpisodeItem,
      episodeIdx?: number,
      source?: StreamSource,
      seconds?: number,
      duration?: number
    ) => {
      setContinueWatching((prev) => {
        const existing = prev.find((p) => p.movie.path === movie.path || p.movie.title === movie.title);
        const filtered = prev.filter((p) => p.movie.path !== movie.path && p.movie.title !== movie.title);
        const entry: WatchProgressItem = {
          movie,
          episodeId: episode?.id ?? existing?.episodeId,
          episodeIdx: episodeIdx ?? existing?.episodeIdx ?? 0,
          episodeLabel: episode?.label ?? existing?.episodeLabel,
          quality: source?.quality ?? existing?.quality,
          audio: source?.audio ?? existing?.audio,
          updatedAt: Date.now(),
          progressSeconds: seconds && seconds > 0 ? seconds : existing?.progressSeconds || 0,
          durationSeconds: duration && duration > 0 ? duration : existing?.durationSeconds || 0,
        };
        return [entry, ...filtered].slice(0, 18);
      });
    },
    []
  );

  const handleExportWatchlist = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      watchlist,
      continueWatching,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CinePulse_Backup.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportWatchlist = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.watchlist)) {
        setWatchlist(parsed.watchlist);
      }
      if (Array.isArray(parsed.continueWatching)) {
        setContinueWatching(parsed.continueWatching);
      }
    } catch {
      // ignore
    }
  };

  const displayedItems = useMemo(() => {
    let list = normalizeMovieCardList(items, liveClockNow);

    if (audioFilter !== 'ALL') {
      list = list.filter((i) => {
        const lang = (i.language + ' ' + i.title).toUpperCase();
        if (audioFilter === 'BANGLA') return lang.includes('BANGLA') || lang.includes('BENGALI');
        if (audioFilter === 'HINDI') return lang.includes('HINDI');
        if (audioFilter === 'DUAL') return lang.includes('DUAL') || lang.includes('MULTI');
        if (audioFilter === 'SUB') return lang.includes('SUB') || lang.includes('JAP') || lang.includes('KOR');
        return true;
      });
    }

    if (qualityFilter !== 'ALL') {
      list = list.filter((i) => {
        const q = (i.quality + ' ' + i.title).toUpperCase();
        if (qualityFilter === '4K') return q.includes('4K') || q.includes('2160P') || q.includes('UHD');
        if (qualityFilter === '1080P') return q.includes('1080P') || q.includes('FULL HD') || q.includes('FHD');
        if (qualityFilter === 'WEBDL') return q.includes('WEB-DL') || q.includes('WEBRIP') || q.includes('BLURAY');
        if (qualityFilter === 'HDTC') return q.includes('HDTC') || q.includes('CAM') || q.includes('HDTS');
        return true;
      });
    }

    if (yearFilter !== 'ALL') {
      list = list.filter((i) => {
        const t = i.title;
        if (yearFilter === '2026') return t.includes('2026');
        if (yearFilter === '2025') return t.includes('2025');
        if (yearFilter === 'OLDER') return !t.includes('2026') && !t.includes('2025');
        return true;
      });
    }

    if (sortBy === 'HOT_HYPE') {
      list = sortItemsByHotAndHype(list, liveClockNow);
    } else if (sortBy === 'LATEST') {
      list.sort((a, b) => getItemMinutesAgo(a, 0, liveClockNow) - getItemMinutesAgo(b, 0, liveClockNow));
    } else if (sortBy === 'RATING') {
      list = sortItemsByHighRating(list, liveClockNow);
    } else if (sortBy === 'VIEWS') {
      list.sort((a, b) => parseViewsCount(b.views) - parseViewsCount(a.views));
    } else if (sortBy === 'TITLE') {
      list.sort((a, b) => a.title.localeCompare(b.title));
    }

    return list;
  }, [items, audioFilter, qualityFilter, yearFilter, sortBy, liveClockNow]);

  const heroSlides = useMemo(() => {
    const pool = normalizeMovieCardList(
      currentCategory.path === '/'
        ? [...displayedItems, ...TOP_10_THIS_WEEK_ITEMS]
        : displayedItems,
      liveClockNow
    );
    const seen = new Set<string>();
    const unique: MovieCardItem[] = [];
    for (const item of pool) {
      const tk = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(item.path) && !seen.has(tk) && item.poster && !brokenImages[item.id]) {
        seen.add(item.path);
        seen.add(tk);
        unique.push(item);
      }
    }
    // Pure highest Hype / Popularity / Hot items for the Auto-Skip Hero Cover
    unique.sort((a, b) => (b.hypeScore || 0) - (a.hypeScore || 0));
    return unique.length > 0 ? unique.slice(0, 8) : displayedItems.slice(0, 8);
  }, [displayedItems, brokenImages, currentCategory.path, liveClockNow]);

  const [heroSlideIdx, setHeroSlideIdx] = useState(0);
  const heroTouchStartXRef = useRef<number | null>(null);

  // Reset slide index when category changes
  useEffect(() => {
    setHeroSlideIdx(0);
  }, [currentCategory.path]);

  // Auto-advance Hero Background Cover through Hot/Popular Movies one after another every 3.8s
  useEffect(() => {
    if (activeTab !== 'browse' || selectedMovie || submittedSearch || currentPage !== 1) return;
    if (heroSlides.length <= 1) return;
    const timer = window.setInterval(() => {
      setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
    }, 3800);
    return () => window.clearInterval(timer);
  }, [activeTab, selectedMovie, submittedSearch, currentPage, heroSlides.length]);

  const safeSlideIdx = heroSlides.length > 0 ? heroSlideIdx % heroSlides.length : 0;

  const spotlightItem = useMemo(() => {
    return (
      heroSlides[safeSlideIdx] ||
      displayedItems.find((i) => i.poster) ||
      displayedItems[0] ||
      INITIAL_FALLBACK_MOVIES['/'][0]
    );
  }, [heroSlides, safeSlideIdx, displayedItems]);

  const heroMiniCards = useMemo(() => {
    if (heroSlides.length === 0) return displayedItems.slice(0, 4);
    const ordered: MovieCardItem[] = [];
    const count = Math.min(6, heroSlides.length);
    for (let i = 0; i < count; i++) {
      ordered.push(heroSlides[(safeSlideIdx + i) % heroSlides.length]);
    }
    return ordered;
  }, [heroSlides, safeSlideIdx, displayedItems]);

  const top10ThisWeekItems = useMemo(() => {
    const merged: MovieCardItem[] = [];
    const seen = new Set<string>();
    const combined = normalizeMovieCardList([...TOP_10_THIS_WEEK_ITEMS, ...displayedItems], liveClockNow);
    for (const item of combined) {
      const tk = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(item.path) && !seen.has(tk) && item.poster && !brokenImages[item.id]) {
        seen.add(item.path);
        seen.add(tk);
        merged.push(item);
        if (merged.length >= 10) break;
      }
    }
    return merged.slice(0, 10);
  }, [displayedItems, brokenImages, liveClockNow]);

  // Last 24 Hours updated movies, series, and anime (Sorted by minutes/hours ago)
  const last24hItems = useMemo(() => {
    const recentPool: MovieCardItem[] = [];
    const seen = new Set<string>();
    const combined = sortItemsByRecentUpload([...items, ...TOP_10_THIS_WEEK_ITEMS], liveClockNow);
    for (const item of combined) {
      const titleKey = item.title.toLowerCase().trim();
      if (seen.has(item.path) || seen.has(titleKey)) continue;
      const mins = getItemMinutesAgo(item, 0, liveClockNow);
      if (mins <= 1440 || item.isPinned) {
        seen.add(item.path);
        seen.add(titleKey);
        recentPool.push(item);
      }
    }
    const baseList = recentPool.length >= 8 ? recentPool : combined.slice(0, 28);
    if (last24hFilter === 'ALL') return baseList;
    if (last24hFilter === 'ANIME') return baseList.filter((i) => i.typeBadge === 'ANIME');
    if (last24hFilter === 'SERIES') {
      return baseList.filter((i) => i.typeBadge === 'SERIES' || i.typeBadge === 'DRAMA' || Boolean(i.episodePill));
    }
    return baseList.filter((i) => i.typeBadge === 'MOVIE' && !i.episodePill);
  }, [items, last24hFilter, liveClockNow]);

  // Automatically pre-warm active Hero slide + top visible movies in the background so clicking them plays in 0ms!
  useEffect(() => {
    if (spotlightItem?.path) {
      prefetchMovieDetails(spotlightItem.path, spotlightItem.title, activeNodeId, true);
    }
    const timer = window.setTimeout(() => {
      const toWarm = [
        spotlightItem,
        ...displayedItems.slice(0, 15),
        ...top10ThisWeekItems.slice(0, 8),
      ].filter(Boolean);
      const seen = new Set<string>();
      toWarm.forEach((m, idx) => {
        if (m?.path && !seen.has(m.path)) {
          seen.add(m.path);
          prefetchMovieDetails(m.path, m.title, activeNodeId, idx < 4);
        }
      });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [spotlightItem, displayedItems, top10ThisWeekItems, activeNodeId]);

  const isMovieInWatchlist = useCallback(
    (movie: MovieCardItem | null) => {
      if (!movie) return false;
      return watchlist.some((m) => m.path === movie.path || m.title === movie.title);
    },
    [watchlist]
  );

  const getMovieWatchlistFolder = useCallback(
    (movie: MovieCardItem | null): WatchlistFolder => {
      if (!movie) return 'favorites';
      const found = watchlist.find((m) => m.path === movie.path || m.title === movie.title);
      return found?.folder || 'favorites';
    },
    [watchlist]
  );

  const selectedMovieProgress = useMemo(() => {
    if (!selectedMovie) return undefined;
    return continueWatching.find(
      (p) => p.movie.path === selectedMovie.path || p.movie.title === selectedMovie.title
    );
  }, [selectedMovie, continueWatching]);

  const filteredWatchlist = useMemo(() => {
    if (watchlistFolderTab === 'all') return watchlist;
    return watchlist.filter((item) => (item.folder || 'favorites') === watchlistFolderTab);
  }, [watchlist, watchlistFolderTab]);

  const activeNodeLabel = useMemo(() => {
    if (activeNodeId === 'node-beta') return 'Node Beta · SG-CDN';
    if (activeNodeId === 'node-gamma') return 'Node Gamma · Global';
    if (activeNodeId === 'node-delta') return 'Node Delta · Backup';
    return 'Node Alpha · BD-Fast';
  }, [activeNodeId]);

  const findCat = (path: string) =>
    ALL_CATEGORIES.find((c) => c.path === path) || ALL_CATEGORIES[0];

  const topNavTabs = [
    { label: 'Trending', cat: findCat('/') },
    { label: 'Anime', cat: findCat('/anime') },
    { label: 'New Bengali', cat: findCat('/language/bangla') },
    { label: 'Bangla Dub', cat: findCat('/language/bangla-dubbed') },
    { label: 'K-Drama', cat: findCat('/drama') },
    { label: 'South Indian', cat: findCat('/southIndian') },
    { label: 'Bollywood', cat: findCat('/bollywood') },
    { label: 'Series', cat: findCat('/ongoing') },
    { label: 'WWE', cat: findCat('/category/wwe') },
    { label: 'Marvel MCU', cat: findCat('/collection/mcu-marvel-cinematic-universe') },
    { label: '18+ Hub', cat: findCat('/adult18plus') },
  ];

  return (
    <div className="min-h-screen w-full bg-[#050505] text-[#e5e5e5] flex flex-col pb-24">
      {/* App Entry Splash Screen with Crimson Red CinePulse Logo */}
      {showSplashScreen && (
        <div
          onClick={() => setShowSplashScreen(false)}
          className="fixed inset-0 z-[9999] bg-[#050505] flex flex-col items-center justify-between py-14 px-6 select-none animate-fade-in"
        >
          <div className="h-8" />

          {/* Center Crimson Red CinePulse Logo */}
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="w-32 h-32 sm:w-36 sm:h-36 rounded-[32px] bg-gradient-to-tr from-[#7f1d1d] via-[#dc2626] to-[#ef4444] p-1 shadow-[0_18px_45px_rgba(220,38,38,0.35)] flex items-center justify-center">
              <div className="w-full h-full bg-[#050505] rounded-[28px] flex items-center justify-center">
                <Play className="w-16 h-16 text-[#ef4444] fill-current ml-1.5 drop-shadow-[0_0_16px_rgba(220,38,38,0.55)]" />
              </div>
            </div>
          </div>

          {/* Bottom Brand Name & Tagline */}
          <div className="text-center space-y-1 pb-4">
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white font-display">
              CINE<span className="text-[#dc2626]">PULSE</span>
            </div>
            <p className="text-xs sm:text-sm font-medium text-gray-400 tracking-wide">
              Box of Movies and TV shows
            </p>
          </div>
        </div>
      )}

      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-[#dc2626] text-white px-4 py-2 text-xs font-semibold flex items-center justify-center gap-2 z-50">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Offline Mode — ক্যাশ করা মুভি তালিকা এবং আপনার ওয়াচলিস্ট দেখানো হচ্ছে</span>
        </div>
      )}

      {/* TOP SEARCH BAR & MAIN CONTENT CONTAINER */}
      <div className="relative w-full max-w-7xl mx-auto">
        {/* Sticky Top Search Bar + Clean Pill Category Strip */}
        <header className="sticky top-0 z-30 bg-[#0a0a0a]/95 backdrop-blur-xl border-b border-white/[0.08] px-3 sm:px-8 pt-2.5 pb-2.5 space-y-2.5 shadow-lg">
          {/* Row 1: Brand Emblem + Uncramped Search Pill + 24h & App Buttons */}
          <div className="flex items-center gap-2 sm:gap-3 w-full">
            {/* Brand Play Emblem */}
            <button
              type="button"
              onClick={() => handleSelectCategory(ALL_CATEGORIES[0])}
              aria-label="Home"
              className="h-10 px-2.5 sm:px-3 rounded-xl bg-[#121212] border border-white/10 hover:border-[#dc2626]/60 shrink-0 flex items-center gap-2 transition-colors"
            >
              <div className="w-6 h-6 rounded-lg bg-[#dc2626] flex items-center justify-center text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]">
                <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
              </div>
              <span className="hidden md:inline text-sm font-black tracking-wider text-white font-display">
                CINE<span className="text-[#dc2626]">PULSE</span>
              </span>
            </button>

            {/* Clean Search Pill Input (Never overflows on 360px mobile screens) */}
            <div ref={searchContainerRef} className="relative flex-1 min-w-0">
              <form
                onSubmit={handleSearchSubmit}
                className="flex items-center w-full h-10 rounded-full bg-[#121212] border border-white/15 focus-within:border-[#dc2626] pl-3 pr-1 overflow-hidden transition-colors"
              >
                <Search className="w-4 h-4 text-[#ef4444] shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onFocus={() => setShowSearchDropdown(true)}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setShowSearchDropdown(true);
                  }}
                  style={{
                    color: '#ffffff',
                    WebkitTextFillColor: '#ffffff',
                    opacity: 1,
                  }}
                  placeholder="মুভি বা সিরিজ খুঁজুন..."
                  className="flex-1 w-full min-w-0 bg-transparent px-2 text-xs sm:text-sm font-semibold text-white placeholder:text-gray-400 placeholder:font-normal caret-[#ef4444] focus:outline-none truncate"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSubmittedSearch('');
                      setSuggestions([]);
                    }}
                    aria-label="Clear search"
                    className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center mr-1 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="submit"
                  className="h-8 px-3.5 rounded-full bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-extrabold whitespace-nowrap shrink-0 shadow-[0_0_12px_rgba(220,38,38,0.4)] transition-colors"
                >
                  খুঁজুন
                </button>
              </form>

              {/* Instant Live Suggestions & Recent Search Dropdown */}
              {showSearchDropdown && (searchQuery.trim().length >= 1 || recentSearches.length > 0) && (
                <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 rounded-2xl bg-[#101010] border border-[#dc2626]/40 shadow-2xl overflow-hidden">
                  {searchQuery.trim().length >= 1 ? (
                    <div className="p-3 space-y-2">
                      <div className="flex items-center justify-between px-1 text-[11px] text-gray-300 font-semibold">
                        <span>
                          সার্চ ফলাফল: <strong className="text-[#ef4444]">"{searchQuery}"</strong>
                        </span>
                        {loadingSuggestions && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#ef4444]" />}
                      </div>
                      {suggestions.length === 0 && !loadingSuggestions ? (
                        <button
                          type="button"
                          onClick={handleSearchSubmit as any}
                          className="w-full py-3 px-3 rounded-xl bg-[#181818] hover:bg-[#222222] text-center text-xs font-bold text-[#ef4444]"
                        >
                          "{searchQuery}" লিখে পুরো ক্যাটালগে সার্চ করুন ➔
                        </button>
                      ) : (
                        <div className="divide-y divide-white/5 max-h-80 overflow-y-auto">
                          {suggestions.map((rawSug) => {
                            const sug = normalizeMovieCardItem(rawSug);
                            return (
                              <button
                                key={sug.path}
                                type="button"
                                onClick={() => {
                                  saveRecentSearch(searchQuery);
                                  setShowSearchDropdown(false);
                                  setSelectedMovie(sug);
                                }}
                                className="w-full py-2 px-2 hover:bg-white/10 flex items-center gap-3 text-left transition-colors rounded-xl"
                              >
                                <div className="relative w-10 h-14 rounded-lg overflow-hidden bg-[#050505] shrink-0 border border-white/10">
                                  {sug.poster && (
                                    <img
                                      src={sug.poster}
                                      alt={sug.title}
                                      referrerPolicy="no-referrer"
                                      className="w-full h-full object-cover"
                                    />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs sm:text-sm font-bold text-white truncate">
                                    {sug.title}
                                  </div>
                                  <div className="text-[11px] text-gray-300 truncate mt-0.5 flex items-center gap-1.5">
                                    <span className="text-amber-400 font-bold flex items-center gap-0.5">
                                      <Star className="w-2.5 h-2.5 fill-current" />
                                      {sug.rating || '9.1'}
                                    </span>
                                    <span>·</span>
                                    <span className="text-[#ef4444] font-semibold">
                                      {formatShortLanguage(sug.language)}
                                    </span>
                                    <span>·</span>
                                    <span className="text-amber-300 font-medium">
                                      {sug.timeAgo}
                                    </span>
                                  </div>
                                </div>
                                <Play className="w-4 h-4 text-[#ef4444] fill-current shrink-0" />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-3.5 space-y-2.5">
                      <div className="flex items-center justify-between text-xs text-gray-400">
                        <span className="flex items-center gap-1.5 font-semibold text-gray-200">
                          <Clock className="w-3.5 h-3.5 text-[#ef4444]" />
                          <span>সাম্প্রতিক সার্চ</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setRecentSearches([])}
                          className="text-[11px] text-gray-400 hover:text-[#ef4444]"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {recentSearches.map((term) => (
                          <button
                            key={term}
                            type="button"
                            onClick={() => {
                              setSearchQuery(term);
                              setSubmittedSearch(term);
                              setShowSearchDropdown(false);
                              setActiveTab('browse');
                            }}
                            className="px-3 py-1.5 rounded-full bg-[#1a1a1a] hover:bg-[#262626] text-xs font-semibold text-white transition-colors"
                          >
                            {term}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* "Last 24 Hours" Live Updates Drawer Button */}
            <button
              type="button"
              onClick={() => setShowLast24hModal(true)}
              title="Last 24 Hours Uploaded Movies & Episodes"
              className="h-10 px-2.5 sm:px-3 rounded-xl bg-[#121212] hover:bg-[#1a1a1a] border border-[#dc2626]/40 text-white font-extrabold text-xs flex items-center gap-1.5 shrink-0 transition-colors"
            >
              <Clock className="w-3.5 h-3.5 text-[#ef4444]" />
              <span className="hidden sm:inline">24h</span>
              <span className="px-1.5 py-0.2 rounded-full bg-[#dc2626] text-white text-[10px] font-black tabular-nums">
                {last24hItems.length}
              </span>
            </button>

            {/* Install App & Live Share Button */}
            <button
              type="button"
              onClick={() => setShowInstallModal(true)}
              title="Install on iPhone / Android or Share Live Link"
              className="h-10 px-2.5 sm:px-3 rounded-xl bg-[#7f1d1d]/30 hover:bg-[#7f1d1d]/50 border border-[#dc2626]/50 text-[#ef4444] font-extrabold text-xs flex items-center gap-1.5 shrink-0 transition-colors"
            >
              <Download className="w-4 h-4 stroke-[2.5]" />
              <span className="hidden sm:inline">{isIOS ? 'iOS App' : 'App'}</span>
            </button>
          </div>

          {/* Row 2: Clean Pill Category Strip (Aligned baseline, zero jumpiness) */}
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-0.5">
            {topNavTabs.map((t) => {
              const isActive =
                activeTab === 'browse' && currentCategory.path === t.cat.path && !submittedSearch;
              return (
                <button
                  key={t.cat.path}
                  type="button"
                  onClick={() => handleSelectCategory(t.cat)}
                  className={`px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-bold whitespace-nowrap shrink-0 transition-all ${
                    isActive
                      ? 'bg-[#dc2626] text-white shadow-[0_2px_12px_rgba(220,38,38,0.4)]'
                      : 'bg-[#121212] text-gray-300 hover:text-white border border-white/[0.08]'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* MAIN VIEW 1: HOME & BROWSE */}
        {activeTab === 'browse' && (
          <main className="space-y-6 px-3 sm:px-8 pt-3">
            {/* Clean Cinema Hero Spotlight + Non-Overlapping Quick-Pick Strip (Page 1 & Not Searching) */}
            {!submittedSearch && currentPage === 1 && spotlightItem && (
              <section className="space-y-3 select-none">
                {/* Main Hero Spotlight Banner */}
                <div
                  onClick={() => setSelectedMovie(spotlightItem)}
                  onTouchStart={(e) => {
                    if (e.touches.length === 1) {
                      heroTouchStartXRef.current = e.touches[0].clientX;
                    }
                  }}
                  onTouchEnd={(e) => {
                    if (heroTouchStartXRef.current !== null && e.changedTouches.length === 1) {
                      const deltaX = e.changedTouches[0].clientX - heroTouchStartXRef.current;
                      heroTouchStartXRef.current = null;
                      if (Math.abs(deltaX) > 45 && heroSlides.length > 1) {
                        if (deltaX < 0) {
                          setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
                        } else {
                          setHeroSlideIdx(
                            (prev) => (prev - 1 + heroSlides.length) % heroSlides.length
                          );
                        }
                      }
                    }
                  }}
                  className="relative aspect-[16/10] sm:aspect-[21/9] w-full rounded-2xl sm:rounded-3xl bg-[#0a0a0a] border border-white/10 cursor-pointer overflow-hidden shadow-2xl group"
                >
                  {spotlightItem.poster && !brokenImages[spotlightItem.id] ? (
                    <img
                      key={spotlightItem.id}
                      src={spotlightItem.poster}
                      alt={spotlightItem.title}
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setBrokenImages((prev) => ({ ...prev, [spotlightItem.id]: true }))
                      }
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1a0b0b] to-[#050505]">
                      <Film className="w-14 h-14 text-gray-600" />
                    </div>
                  )}

                  {/* Measured Contrast Scrims */}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-[#050505]/60 to-transparent" />
                  <div className="absolute inset-0 bg-gradient-to-r from-[#050505]/85 via-transparent to-transparent" />

                  {/* Top Row: Trending Badge & Slide Arrows */}
                  <div className="absolute top-3 left-3.5 right-3.5 z-20 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="px-2.5 py-0.5 rounded-md bg-[#dc2626] text-white text-[10px] sm:text-[11px] font-black tracking-wide shadow-[0_0_12px_rgba(220,38,38,0.45)] flex items-center gap-1">
                        <Flame className="w-3 h-3 fill-current" />
                        <span>SPOTLIGHT #{safeSlideIdx + 1}</span>
                      </span>
                      <span className="px-2.5 py-0.5 rounded-md bg-black/75 backdrop-blur-md border border-white/15 text-[11px] font-bold text-amber-300 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{spotlightItem.timeAgo}</span>
                      </span>
                    </div>

                    {heroSlides.length > 1 && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1.5"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setHeroSlideIdx(
                              (prev) => (prev - 1 + heroSlides.length) % heroSlides.length
                            )
                          }
                          aria-label="Previous Slide"
                          className="w-8 h-8 rounded-full bg-black/65 hover:bg-black/85 border border-white/15 text-white flex items-center justify-center active:scale-90 transition-transform"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length)}
                          aria-label="Next Slide"
                          className="w-8 h-8 rounded-full bg-black/65 hover:bg-black/85 border border-white/15 text-white flex items-center justify-center active:scale-90 transition-transform"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Bottom Hero Content: Title + Metadata + Watch CTA + Slide Dots */}
                  <div className="absolute inset-x-0 bottom-0 z-20 p-4 sm:p-6 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                    <div className="space-y-1.5 max-w-xl min-w-0">
                      <h1 className="text-lg sm:text-2xl md:text-3xl font-extrabold text-white tracking-tight line-clamp-1 drop-shadow">
                        {spotlightItem.title}
                      </h1>
                      <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-gray-200 font-medium">
                        <span className="text-amber-400 font-extrabold flex items-center gap-1">
                          <Star className="w-3.5 h-3.5 fill-current" />
                          <span>{spotlightItem.rating || '9.4'}</span>
                        </span>
                        <span>·</span>
                        <span className="text-[#ef4444] font-bold">
                          {formatShortLanguage(spotlightItem.language)}
                        </span>
                        <span>·</span>
                        <span>{spotlightItem.episodePill || spotlightItem.quality}</span>
                        <span>·</span>
                        <span className="font-mono tabular-nums text-gray-300">
                          {spotlightItem.views} views
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedMovie(spotlightItem);
                        }}
                        className="h-10 px-4 sm:px-5 rounded-xl bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs sm:text-sm font-extrabold flex items-center gap-1.5 shadow-[0_4px_16px_rgba(220,38,38,0.45)] transition-transform active:scale-95"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>এখনই দেখুন</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleWatchlist(spotlightItem);
                        }}
                        aria-label="Save to Watchlist"
                        className={`h-10 w-10 rounded-xl border flex items-center justify-center transition-colors ${
                          isMovieInWatchlist(spotlightItem)
                            ? 'bg-[#dc2626]/20 border-[#dc2626] text-[#ef4444]'
                            : 'bg-black/65 border-white/15 text-white hover:bg-black/85'
                        }`}
                      >
                        <Bookmark
                          className={`w-4 h-4 ${
                            isMovieInWatchlist(spotlightItem) ? 'fill-current' : ''
                          }`}
                        />
                      </button>

                      {/* Slide Progress Dots */}
                      {heroSlides.length > 1 && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 ml-1"
                        >
                          {heroSlides.map((slide, idx) => (
                            <button
                              key={slide.id + idx}
                              type="button"
                              aria-label={`Slide ${idx + 1}`}
                              onClick={() => setHeroSlideIdx(idx)}
                              className={`h-1.5 rounded-full transition-all duration-300 ${
                                idx === safeSlideIdx
                                  ? 'w-5 bg-[#dc2626]'
                                  : 'w-1.5 bg-white/35 hover:bg-white/65'
                              }`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Clean Horizontal Trending Quick-Pick Strip (Below Hero — Zero Overlap) */}
                <div className="flex items-stretch gap-2.5 overflow-x-auto no-scrollbar pb-0.5">
                  {heroMiniCards.map((card, idx) => (
                    <div
                      key={card.path + card.id + idx}
                      onMouseEnter={() => prefetchMovieDetails(card.path, card.title, activeNodeId)}
                      onTouchStart={() => prefetchMovieDetails(card.path, card.title, activeNodeId)}
                      onClick={() => setSelectedMovie(card)}
                      className={`w-[245px] sm:w-[275px] shrink-0 rounded-2xl bg-[#101010] border p-2.5 flex items-center gap-2.5 cursor-pointer transition-all ${
                        idx === 0
                          ? 'border-[#dc2626]/65 bg-[#161010]'
                          : 'border-white/[0.08] hover:border-[#dc2626]/50'
                      }`}
                    >
                      <div className="relative w-11 h-15 rounded-xl overflow-hidden bg-[#050505] shrink-0 border border-white/10">
                        {card.poster && (
                          <img
                            src={card.poster}
                            alt={card.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <h2 className="text-xs sm:text-sm font-bold text-white truncate">
                          {card.title}
                        </h2>
                        <div className="text-[11px] text-gray-300 truncate mt-0.5 flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-0.5 text-amber-400 font-bold shrink-0">
                            <Star className="w-2.5 h-2.5 fill-current" />
                            <span>{card.rating || '9.2'}</span>
                          </span>
                          <span>·</span>
                          <span className="truncate text-[#ef4444] font-semibold">
                            {formatShortLanguage(card.language)}
                          </span>
                          <span>·</span>
                          <span className="text-amber-300 font-medium truncate">
                            {card.timeAgo}
                          </span>
                        </div>
                      </div>

                      <div className="w-8 h-8 rounded-full bg-[#dc2626]/20 text-[#ef4444] flex items-center justify-center shrink-0">
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Continue Watching Strip (If user has watch progress) */}
            {continueWatching.length > 0 && !submittedSearch && currentPage === 1 && (
              <section className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-base sm:text-lg font-extrabold text-white">
                    Continue Watching
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveTab('watchlist')}
                    className="text-xs text-[#ef4444] font-bold flex items-center gap-0.5"
                  >
                    <span>All</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-3 overflow-x-auto no-scrollbar pb-1">
                  {continueWatching.slice(0, 8).map((entry) => {
                    const pct =
                      entry.durationSeconds && entry.progressSeconds
                        ? Math.min(
                            98,
                            Math.max(8, Math.round((entry.progressSeconds / entry.durationSeconds) * 100))
                          )
                        : 30;
                    return (
                      <div
                        key={entry.movie.path}
                        onClick={() => setSelectedMovie(entry.movie)}
                        className="w-40 sm:w-44 shrink-0 rounded-xl overflow-hidden bg-[#101010] border border-white/[0.08] hover:border-[#dc2626]/50 cursor-pointer group"
                      >
                        <div className="relative aspect-[16/10] w-full bg-[#050505] overflow-hidden">
                          <img
                            src={entry.movie.poster}
                            alt={entry.movie.title}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                          <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
                            <div className="w-8 h-8 rounded-full bg-[#dc2626] text-white flex items-center justify-center shadow-[0_0_12px_rgba(220,38,38,0.5)]">
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            </div>
                          </div>
                          <div className="absolute bottom-0 inset-x-0 h-1 bg-white/20">
                            <div className="h-full bg-[#dc2626]" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <div className="p-2">
                          <div className="text-xs font-bold text-white truncate">
                            {entry.movie.title}
                          </div>
                          <div className="text-[10px] text-[#ef4444] truncate mt-0.5 font-semibold">
                            {entry.episodeLabel || 'Movie'} · {formatResumeTime(entry.progressSeconds)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* PRIMARY SECTION: ALL MOVIES & SERIES CATALOG GRID (Moved up for immediate access!) */}
            <section className="space-y-3.5">
              {/* Section Header + Filter Toolbar */}
              <div className="rounded-2xl bg-[#0a0a0a] border border-white/[0.08] p-3 sm:p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Flame className="w-5 h-5 text-[#ef4444] shrink-0" />
                    <h2 className="text-base sm:text-xl font-extrabold text-white tracking-tight truncate">
                      {submittedSearch
                        ? `সার্চ ফলাফল: "${submittedSearch}"`
                        : `${currentCategory.label} · ${currentCategory.bnLabel}`}
                    </h2>
                  </div>
                  <span className="text-xs text-gray-400 font-mono tabular-nums shrink-0">
                    Page {currentPage}/{maxPage}
                  </span>
                </div>

                {/* Clean Audio Filter Segmented Controls + Quality/Sort Selectors */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                    {[
                      { label: 'All Audio', id: 'ALL' },
                      { label: 'Bengali', id: 'BANGLA' },
                      { label: 'Hindi', id: 'HINDI' },
                      { label: 'Dual Audio', id: 'DUAL' },
                      { label: 'Anime / Sub', id: 'SUB' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setAudioFilter(f.id as any)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 transition-colors ${
                          audioFilter === f.id
                            ? 'bg-[#dc2626] text-white shadow-[0_0_10px_rgba(220,38,38,0.35)]'
                            : 'bg-[#141414] text-gray-300 hover:text-white border border-white/5'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* Compact Quality & Sort Dropdowns */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-[#141414] border border-white/10 rounded-xl px-2.5 py-1.5">
                      <SlidersHorizontal className="w-3 h-3 text-[#ef4444]" />
                      <select
                        value={qualityFilter}
                        onChange={(e) => setQualityFilter(e.target.value as any)}
                        aria-label="Filter quality"
                        className="bg-transparent text-xs font-semibold text-gray-200 focus:outline-none"
                      >
                        <option value="ALL" className="bg-[#121212]">All Quality</option>
                        <option value="4K" className="bg-[#121212]">4K UHD</option>
                        <option value="1080P" className="bg-[#121212]">1080p FHD</option>
                        <option value="WEBDL" className="bg-[#121212]">WEB-DL</option>
                        <option value="HDTC" className="bg-[#121212]">HDTC</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-1 bg-[#141414] border border-white/10 rounded-xl px-2.5 py-1.5">
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as any)}
                        aria-label="Sort order"
                        className="bg-transparent text-xs font-semibold text-gray-200 focus:outline-none"
                      >
                        <option value="HOT_HYPE" className="bg-[#121212]">Hot & New</option>
                        <option value="LATEST" className="bg-[#121212]">Latest Upload</option>
                        <option value="RATING" className="bg-[#121212]">Top Rated</option>
                        <option value="VIEWS" className="bg-[#121212]">Most Popular</option>
                        <option value="TITLE" className="bg-[#121212]">A–Z</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {loadingCatalog && (
                <div className="flex items-center justify-center gap-2 py-3 rounded-2xl bg-[#101010] text-xs text-gray-300">
                  <Loader2 className="w-4 h-4 animate-spin text-[#ef4444]" />
                  <span>লোড হচ্ছে (Page {currentPage})...</span>
                </div>
              )}

              {/* 3-Column Mobile / 5-Column Desktop Ultra-Clean Poster Grid */}
              {displayedItems.length === 0 ? (
                <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-10 text-center space-y-3">
                  <Film className="w-10 h-10 text-gray-500 mx-auto" />
                  <h3 className="text-base font-bold text-white">কোনো মুভি বা সিরিজ পাওয়া যায়নি</h3>
                  <button
                    type="button"
                    onClick={() => {
                      setAudioFilter('ALL');
                      setQualityFilter('ALL');
                      setYearFilter('ALL');
                      setSubmittedSearch('');
                      setSearchQuery('');
                    }}
                    className="px-5 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5 sm:gap-4">
                  {displayedItems.map((item) => {
                    const isSaved = isMovieInWatchlist(item);
                    const hasBrokenImg = brokenImages[item.id] || !item.poster;
                    const isJustUploaded = isUploadedWithinMinutes(item.timeAgo);

                    return (
                      <article
                        key={item.path + item.title}
                        onMouseEnter={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onTouchStart={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onClick={() => setSelectedMovie(item)}
                        className="group rounded-2xl overflow-hidden bg-[#0a0a0a] border border-white/[0.08] hover:border-[#dc2626]/65 transition-all flex flex-col cursor-pointer shadow-sm"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          {!hasBrokenImg ? (
                            <img
                              src={item.poster}
                              alt={item.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              onError={() =>
                                setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                              }
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center">
                              <Film className="w-7 h-7 text-[#ef4444] mb-1.5 opacity-80" />
                              <span className="text-[11px] font-bold text-gray-300 line-clamp-3">
                                {item.title}
                              </span>
                            </div>
                          )}

                          {/* Top-Right Language Tag */}
                          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-xs text-[9px] sm:text-[10px] font-bold text-white border border-white/10">
                            {formatShortLanguage(item.language)}
                          </span>

                          {/* Top-Left Bookmark / HOT */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleWatchlist(item);
                            }}
                            aria-label="Save to list"
                            className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-lg backdrop-blur-xs flex items-center justify-center transition-colors ${
                              isSaved
                                ? 'bg-[#dc2626] text-white'
                                : 'bg-black/60 text-white/85 hover:text-white'
                            }`}
                          >
                            <Bookmark className={`w-3 h-3 ${isSaved ? 'fill-current' : ''}`} />
                          </button>

                          {/* Bottom Scrim: Episode/Quality + Star Rating */}
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 pt-5 pb-1.5 flex items-center justify-between gap-1 text-[10px]">
                            <span className="font-bold text-[#ef4444] truncate">
                              {item.episodePill || item.quality}
                            </span>
                            <span className="text-amber-400 font-bold flex items-center gap-0.5 shrink-0">
                              <Star className="w-2.5 h-2.5 fill-current" />
                              <span>{item.rating || '9.0'}</span>
                            </span>
                          </div>
                        </div>

                        <div className="p-2 sm:p-2.5 flex-1 flex flex-col justify-between space-y-1">
                          <h3 className="text-xs sm:text-sm font-bold text-gray-100 truncate group-hover:text-[#ef4444] transition-colors">
                            {item.title}
                          </h3>
                          <div className="flex items-center justify-between text-[10px] text-gray-400">
                            <span
                              className={`font-medium truncate ${
                                isJustUploaded ? 'text-[#ef4444]' : 'text-amber-300/90'
                              }`}
                            >
                              {item.timeAgo}
                            </span>
                            <span className="font-mono tabular-nums text-gray-400 shrink-0 hidden xs:inline">
                              {item.views}
                            </span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {/* 🏆 TOP 10 THIS WEEK RAIL (Cleanly organized below main grid on Page 1) */}
              {!submittedSearch && currentPage === 1 && (
                <div className="pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Trophy className="w-5 h-5 text-[#ef4444]" />
                      <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                        TOP 10 THIS WEEK · সেরা ১০ হিট
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectCategory(findCat('/mostwatch/7d'))}
                      className="text-xs text-[#ef4444] font-bold flex items-center gap-0.5"
                    >
                      <span>Most Watched</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                    {top10ThisWeekItems.map((item, idx) => (
                      <div
                        key={item.path + idx}
                        onMouseEnter={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onTouchStart={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onClick={() => setSelectedMovie(item)}
                        className="w-[136px] sm:w-[162px] shrink-0 rounded-2xl overflow-hidden bg-[#0a0a0a] border border-white/[0.08] hover:border-[#dc2626]/60 cursor-pointer group flex flex-col transition-all"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          {item.poster && !brokenImages[item.id] ? (
                            <img
                              src={item.poster}
                              alt={item.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              onError={() =>
                                setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                              }
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-8 h-8 text-gray-600" />
                            </div>
                          )}

                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-[#dc2626] text-white text-[10px] font-black shadow">
                            #{idx + 1}
                          </span>

                          <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-black/75 text-[9px] font-semibold text-white">
                            {formatShortLanguage(item.language)}
                          </span>

                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-2 pt-4 pb-1.5 flex items-center justify-between text-[10px]">
                            <span className="font-semibold text-[#ef4444] truncate">
                              {item.episodePill || item.quality}
                            </span>
                            <span className="text-amber-400 font-bold flex items-center gap-0.5">
                              <Star className="w-2.5 h-2.5 fill-current" />
                              {item.rating || '9.3'}
                            </span>
                          </div>
                        </div>

                        <div className="p-2 space-y-0.5">
                          <h3 className="text-xs font-bold text-gray-100 truncate group-hover:text-[#ef4444]">
                            {item.title}
                          </h3>
                          <p className="text-[10px] text-amber-300/90 truncate">{item.timeAgo}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 📚 CURATED FRANCHISE COLLECTIONS & UPCOMING RELEASES */}
              {!submittedSearch && currentPage === 1 && (
                <div className="pt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Layers className="w-5 h-5 text-[#ef4444]" />
                      <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                        COLLECTIONS · জনপ্রিয় কালেকশন
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectCategory(findCat('/collections'))}
                      className="text-xs text-[#ef4444] font-bold flex items-center gap-0.5"
                    >
                      <span>Show All</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                    {CURATED_COLLECTION_CARDS.map((coll) => (
                      <button
                        key={coll.path}
                        type="button"
                        onClick={() =>
                          handleSelectCategory({
                            label: coll.title,
                            bnLabel: coll.bnTitle,
                            path: coll.path,
                            group: 'collection',
                          })
                        }
                        className="w-[210px] sm:w-[235px] shrink-0 rounded-2xl bg-[#0a0a0a] hover:bg-[#141414] border border-white/[0.08] hover:border-[#dc2626]/60 p-2.5 text-left flex flex-col justify-between transition-all group cursor-pointer"
                      >
                        <div className="grid grid-cols-2 gap-1.5 aspect-[16/10] w-full rounded-xl overflow-hidden bg-[#050505] mb-2">
                          {coll.posters.map((posterUrl, pIdx) => (
                            <div key={pIdx} className="w-full h-full overflow-hidden bg-[#101010]">
                              <img
                                src={posterUrl}
                                alt=""
                                referrerPolicy="no-referrer"
                                loading="lazy"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            </div>
                          ))}
                        </div>

                        <div>
                          <h3 className="text-xs sm:text-sm font-extrabold text-white line-clamp-1 group-hover:text-[#ef4444]">
                            {coll.title}
                          </h3>
                          <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
                            <span className="truncate">{coll.bnTitle}</span>
                            <span className="font-mono text-[#ef4444] font-bold shrink-0">
                              {coll.countLabel}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 📅 UPCOMING RELEASES */}
              {!submittedSearch && currentPage === 1 && (
                <div className="pt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-5 h-5 text-[#ef4444]" />
                      <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                        UPCOMING RELEASES · আপকামিং রিলিজ
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectCategory(findCat('/upcoming'))}
                      className="text-xs text-gray-400 hover:text-white flex items-center gap-0.5"
                    >
                      <span>All Upcoming</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                    {UPCOMING_RELEASES.map((up) => (
                      <div
                        key={up.id}
                        onClick={() => {
                          setSearchQuery(up.searchQuery);
                          setSubmittedSearch(up.searchQuery);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="w-[136px] sm:w-[158px] shrink-0 rounded-2xl overflow-hidden bg-[#0a0a0a] border border-white/[0.08] hover:border-[#dc2626]/60 cursor-pointer group flex flex-col"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          <img
                            src={up.poster}
                            alt={up.title}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div
                            title={up.fullDate}
                            className="absolute top-2 left-2 rounded-lg overflow-hidden shadow-lg border border-white/20 text-center min-w-[38px]"
                          >
                            <div className="bg-[#dc2626] text-white text-[8px] font-black uppercase py-0.5 px-1.5">
                              {up.month}
                            </div>
                            <div className="bg-black/85 text-white text-xs font-extrabold font-mono py-0.5 px-1.5">
                              {up.day}
                            </div>
                          </div>
                        </div>
                        <div className="p-2">
                          <h3 className="text-xs font-bold text-gray-100 truncate group-hover:text-[#ef4444]">
                            {up.title}
                          </h3>
                          <p className="text-[10px] text-gray-400 mt-0.5">{up.fullDate}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Bottom 520-Page Pagination Bar */}
              <div className="rounded-2xl bg-[#0a0a0a] border border-white/[0.08] p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => handlePageChange(currentPage - 1)}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#141414] hover:bg-[#222222] disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Prev</span>
                  </button>

                  {Array.from({ length: 5 }, (_, idx) => {
                    const start = Math.max(1, Math.min(currentPage - 2, maxPage - 4));
                    const pageNum = start + idx;
                    if (pageNum < 1 || pageNum > maxPage) return null;
                    return (
                      <button
                        key={pageNum}
                        type="button"
                        onClick={() => handlePageChange(pageNum)}
                        className={`min-h-[40px] min-w-[40px] px-3 py-1.5 rounded-xl text-xs font-bold font-mono tabular-nums transition-colors ${
                          currentPage === pageNum
                            ? 'bg-[#dc2626] text-white shadow-[0_0_12px_rgba(220,38,38,0.4)]'
                            : 'bg-[#141414] text-gray-300 hover:bg-[#222222]'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    disabled={currentPage >= maxPage}
                    onClick={() => handlePageChange(currentPage + 1)}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#141414] hover:bg-[#222222] disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleJumpPage} className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={maxPage}
                    value={jumpPageInput}
                    onChange={(e) => setJumpPageInput(e.target.value)}
                    placeholder={`Page (1-${maxPage})`}
                    className="w-28 min-h-[40px] px-3 py-1.5 rounded-xl bg-[#141414] border border-white/10 text-xs text-white placeholder-gray-400 font-mono tabular-nums focus:outline-none focus:border-[#dc2626]"
                  />
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-extrabold whitespace-nowrap"
                  >
                    Go
                  </button>
                </form>
              </div>
            </section>
          </main>
        )}

        {/* VIEW 2: ALL 55+ CATEGORIES HUB ("Explore Hub") */}
        {activeTab === 'categories' && (
          <main className="px-3.5 sm:px-8 pt-2 space-y-6">
            <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-6">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h1 className="text-lg sm:text-xl font-extrabold text-white">
                    Explore All 55+ Categories & Zones
                  </h1>
                  <p className="text-xs text-gray-400 mt-0.5">
                    যেকোনো ক্যাটাগরিতে ট্যাপ করে ৫২০+ পেজের সব মুভি ও সিরিজ দেখুন
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('browse')}
                  className="px-4 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                >
                  Back Home
                </button>
              </div>

              {(
                [
                  { group: 'zone', title: 'Featured Zones' },
                  { group: 'language', title: 'Languages & Audio Dubs' },
                  { group: 'genre', title: 'Movie & Anime Genres' },
                  { group: 'collection', title: 'Curated Franchises & Collections' },
                ] as const
              ).map((section) => {
                const groupItems = ALL_CATEGORIES.filter((c) => c.group === section.group);
                if (groupItems.length === 0) return null;
                return (
                  <div key={section.group} className="space-y-3">
                    <h2 className="text-sm font-extrabold text-[#ef4444]">{section.title}</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                      {groupItems.map((cat) => (
                        <button
                          key={cat.path}
                          type="button"
                          onClick={() => handleSelectCategory(cat)}
                          className={`min-h-[52px] px-3.5 py-2.5 rounded-2xl text-left transition-colors border flex flex-col justify-center ${
                            currentCategory.path === cat.path
                              ? 'bg-[#7f1d1d]/35 text-white border-[#dc2626]'
                              : 'bg-[#121212] text-gray-200 border-white/5 hover:border-[#dc2626]/50'
                          }`}
                        >
                          <span className="text-xs font-bold truncate">{cat.label}</span>
                          <span className="text-[11px] text-gray-400 truncate mt-0.5">
                            {cat.bnLabel}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </main>
        )}

        {/* VIEW 3: DOWNLOADS & WATCHLIST FOLDERS */}
        {activeTab === 'watchlist' && (
          <main className="px-3.5 sm:px-8 pt-2 space-y-6">
            {/* Saved Watchlist & Custom Folders */}
            <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-extrabold text-white">
                    My List & Saved Downloads ({watchlist.length})
                  </h2>
                  <p className="text-xs text-gray-400">
                    আপনার পছন্দের সেভ করা মুভি, অ্যানিমে ও ওয়াচ হিস্ট্রি
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportWatchlist}
                    className="px-3 py-1.5 rounded-full bg-[#141414] border border-white/10 text-xs font-semibold text-gray-200 flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5 text-[#ef4444]" />
                    <span>Backup</span>
                  </button>

                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportWatchlist}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => backupInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-full bg-[#141414] border border-white/10 text-xs font-semibold text-gray-200 flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5 text-[#ef4444]" />
                    <span>Restore</span>
                  </button>
                </div>
              </div>

              {/* Folder Tabs */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                {(
                  [
                    { id: 'all', label: `All (${watchlist.length})` },
                    {
                      id: 'favorites',
                      label: `Favorites (${watchlist.filter((m) => (m.folder || 'favorites') === 'favorites').length})`,
                    },
                    {
                      id: 'watch_later',
                      label: `Watch Later (${watchlist.filter((m) => m.folder === 'watch_later').length})`,
                    },
                    {
                      id: 'anime_series',
                      label: `Series & Anime (${watchlist.filter((m) => m.folder === 'anime_series').length})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setWatchlistFolderTab(tab.id)}
                    className={`px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                      watchlistFolderTab === tab.id
                        ? 'bg-[#dc2626] text-white'
                        : 'bg-[#141414] text-gray-300'
                    }`}
                  >
                    <FolderHeart className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {filteredWatchlist.length === 0 ? (
                <div className="py-10 text-center space-y-3">
                  <Bookmark className="w-8 h-8 text-gray-500 mx-auto" />
                  <p className="text-sm text-gray-300 font-medium">No movies saved in this folder yet</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('browse')}
                    className="px-5 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                  >
                    Discover Movies
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {filteredWatchlist.map((item) => {
                    const normItem = normalizeMovieCardItem(item);
                    return (
                      <div
                        key={item.path}
                        onClick={() => setSelectedMovie(normItem)}
                        className="group rounded-xl overflow-hidden bg-[#121212] border border-white/[0.08] cursor-pointer flex flex-col"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          <img
                            src={item.poster}
                            alt={item.title}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                          <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded bg-black/75 text-[10px] font-semibold text-white">
                            {formatShortLanguage(item.language)}
                          </span>
                          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-bold text-amber-300 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {normItem.timeAgo}
                          </span>
                        </div>
                        <div className="p-2">
                          <h3 className="text-xs font-bold text-white truncate">{item.title}</h3>
                          <p className="text-[10px] text-amber-300 mt-0.5">{normItem.timeAgo}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Watch History */}
            {continueWatching.length > 0 && (
              <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-extrabold text-white">
                    Recent Watch History ({continueWatching.length})
                  </h2>
                  <button
                    type="button"
                    onClick={() => setContinueWatching([])}
                    className="text-xs text-[#ef4444] flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {continueWatching.map((entry) => {
                    const normMovie = normalizeMovieCardItem(entry.movie);
                    return (
                      <div
                        key={entry.movie.path}
                        onClick={() => setSelectedMovie(normMovie)}
                        className="rounded-xl overflow-hidden bg-[#121212] border border-white/[0.08] cursor-pointer"
                      >
                        <div className="relative aspect-[2/3] w-full">
                          <img
                            src={entry.movie.poster}
                            alt={entry.movie.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-black/80 px-2 py-1 text-[10px] text-[#ef4444] font-semibold truncate">
                            {entry.episodeLabel || 'Movie'} · {formatResumeTime(entry.progressSeconds)}
                          </div>
                        </div>
                        <div className="p-2">
                          <div className="text-xs font-semibold text-white truncate">
                            {entry.movie.title}
                          </div>
                          <div className="text-[10px] text-amber-300 mt-0.5">
                            {normMovie.timeAgo}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </main>
        )}
      </div>

      {/* FIXED BOTTOM NAVIGATION BAR WITH ELEVATED CENTER SHORTS/18+ BUTTON */}
      <nav
        aria-label="Bottom Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0a0a]/95 backdrop-blur-lg border-t border-white/[0.08] pb-safe"
      >
        <div className="max-w-xl mx-auto grid grid-cols-5 items-center h-16 px-2">
          {/* 1. Home */}
          <button
            type="button"
            onClick={() => handleSelectCategory(ALL_CATEGORIES[0])}
            className={`flex flex-col items-center justify-center transition-colors ${
              activeTab === 'browse' && currentCategory.path !== '/adult18plus'
                ? 'text-[#ef4444]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Home</span>
          </button>

          {/* 2. Categories Hub (With Red HOT Badge) */}
          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            className={`relative flex flex-col items-center justify-center transition-colors ${
              activeTab === 'categories' ? 'text-[#ef4444]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <div className="relative">
              <BookOpen className="w-5 h-5" />
              <span className="absolute -top-1.5 -right-5 px-1 py-0.2 rounded bg-[#dc2626] text-[8px] font-extrabold text-white leading-tight">
                HOT
              </span>
            </div>
            <span className="text-[11px] font-medium mt-1">Explore</span>
          </button>

          {/* 3. Center Elevated Circular Poster Button ("18+ Hub") */}
          <div className="flex flex-col items-center justify-center">
            <button
              type="button"
              onClick={() => handleSelectCategory(ALL_CATEGORIES[6])}
              className="relative -mt-6 w-14 h-14 rounded-full p-0.5 bg-gradient-to-tr from-[#7f1d1d] via-[#dc2626] to-[#ef4444] shadow-[0_6px_20px_rgba(220,38,38,0.45)] flex items-center justify-center transition-transform active:scale-95"
            >
              <div className="w-full h-full rounded-full overflow-hidden bg-[#121212] relative flex items-center justify-center">
                {spotlightItem?.poster && (
                  <img
                    src={spotlightItem.poster}
                    alt="18+ Hub"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover opacity-75"
                  />
                )}
                <div className="absolute inset-0 bg-black/35 flex flex-col items-center justify-center">
                  <div className="w-6 h-6 rounded-full bg-[#dc2626] text-white flex items-center justify-center shadow">
                    <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                  </div>
                </div>
              </div>
              <span className="absolute -bottom-1 px-1.5 py-0.2 rounded-full bg-black/90 text-[9px] font-extrabold text-white border border-[#dc2626]/50">
                18+ Hub
              </span>
            </button>
          </div>

          {/* 4. Downloads / Watchlist */}
          <button
            type="button"
            onClick={() => setActiveTab('watchlist')}
            className={`flex flex-col items-center justify-center transition-colors ${
              activeTab === 'watchlist' ? 'text-[#ef4444]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Download className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Downloads</span>
          </button>

          {/* 5. Me / Servers & Request */}
          <button
            type="button"
            onClick={() => {
              setRequestPrefillTitle('');
              setRequestPrefillType('MOVIE');
              setShowRequestModal(true);
            }}
            className={`flex flex-col items-center justify-center transition-colors ${
              showRequestModal ? 'text-[#ef4444]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <div className="relative">
              <User className="w-5 h-5" />
              <span className="w-2 h-2 rounded-full bg-[#dc2626] absolute -top-0.5 -right-1" />
            </div>
            <span className="text-[11px] font-medium mt-1">Me</span>
          </button>
        </div>
      </nav>

      {/* Full-Screen MovieBox Style Player & Floating Mini-Player View */}
      <MovieDetailModal
        movie={selectedMovie}
        relatedMovies={displayedItems}
        activeNodeId={activeNodeId}
        savedProgress={selectedMovieProgress}
        isMiniPlayer={isMiniPlayer}
        onToggleMiniPlayer={(mini) => setIsMiniPlayer(mini)}
        onClose={() => {
          setIsMiniPlayer(false);
          setSelectedMovie(null);
        }}
        onSelectMovie={(m) => {
          setIsMiniPlayer(false);
          setSelectedMovie(m);
        }}
        isInWatchlist={isMovieInWatchlist(selectedMovie)}
        currentFolder={getMovieWatchlistFolder(selectedMovie)}
        onToggleWatchlist={handleToggleWatchlist}
        onRecordWatchProgress={handleRecordWatchProgress}
        onSearchByActor={handleTriggerActorSearch}
        onOpenReportModal={(prefillTitle) => {
          setRequestPrefillTitle(prefillTitle);
          setRequestPrefillType('BROKEN_LINK');
          setShowRequestModal(true);
        }}
      />

      {/* Movie Request & Anonymized Server Switcher Modal */}
      <MovieRequestModal
        isOpen={showRequestModal}
        initialTitle={requestPrefillTitle}
        initialType={requestPrefillType}
        activeNodeId={activeNodeId}
        onSelectNode={(nodeId) => setActiveNodeId(nodeId)}
        onClose={() => setShowRequestModal(false)}
      />

      {/* FEATURE 3 MODAL: 🕒 Last 24 Hours Uploaded Movies & Episodes Drawer */}
      {showLast24hModal && (
        <div
          onClick={() => setShowLast24hModal(false)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[86vh] rounded-t-3xl sm:rounded-3xl bg-[#0a0a0a] border border-white/15 flex flex-col overflow-hidden shadow-2xl"
          >
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#dc2626]/20 border border-[#dc2626]/40 flex items-center justify-center text-[#ef4444]">
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base sm:text-lg font-extrabold text-white">
                    Last 24 Hours · নতুন আপলোড
                  </h2>
                  <p className="text-xs text-gray-400">
                    গত ২৪ ঘণ্টায় আপলোড হওয়া সব নতুন মুভি, সিরিজ ও এপিসোড ({last24hItems.length})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLast24hModal(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-gray-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Filter Tabs */}
            <div className="px-5 py-2.5 bg-[#050505] border-b border-white/5 flex items-center gap-2 overflow-x-auto no-scrollbar">
              {(
                [
                  { id: 'ALL', label: 'All Updates' },
                  { id: 'MOVIE', label: 'Movies' },
                  { id: 'SERIES', label: 'Web Series & Drama' },
                  { id: 'ANIME', label: 'Anime' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setLast24hFilter(t.id)}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-colors ${
                    last24hFilter === t.id
                      ? 'bg-[#dc2626] text-white'
                      : 'bg-[#141414] text-gray-300 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* List of 24h Items */}
            <div className="p-4 overflow-y-auto divide-y divide-white/5 space-y-1 flex-1">
              {last24hItems.map((item, idx) => (
                <button
                  key={item.path + idx}
                  type="button"
                  onMouseEnter={() => prefetchMovieDetails(item.path, item.title, activeNodeId)}
                  onTouchStart={() => prefetchMovieDetails(item.path, item.title, activeNodeId)}
                  onClick={() => {
                    setShowLast24hModal(false);
                    setSelectedMovie(item);
                  }}
                  className="w-full py-2.5 px-2.5 hover:bg-white/5 rounded-2xl flex items-center gap-3.5 text-left transition-colors"
                >
                  <span className="w-6 text-xs font-mono font-bold text-gray-500 text-center shrink-0">
                    {idx + 1}
                  </span>
                  <div className="w-12 h-16 rounded-xl overflow-hidden bg-[#050505] shrink-0 border border-white/10">
                    {item.poster && (
                      <img
                        src={item.poster}
                        alt={item.title}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xs sm:text-sm font-bold text-white truncate">
                      {item.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-gray-400">
                      <span className="text-[#ef4444] font-semibold">
                        {formatShortLanguage(item.language)}
                      </span>
                      <span>·</span>
                      <span>{item.episodePill || item.quality}</span>
                      <span>·</span>
                      <span className="text-amber-300 font-medium">{item.timeAgo}</span>
                    </div>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-[#dc2626]/20 text-[#ef4444] flex items-center justify-center shrink-0">
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* iPhone PWA Install Guide Modal */}
      <PWAInstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
        isInstallable={isInstallable}
        isInstalled={isInstalled}
        isIOS={isIOS}
        onTriggerInstall={install}
      />
    </div>
  );
}
