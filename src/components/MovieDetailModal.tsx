import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  Download,
  FastForward,
  FileText,
  Film,
  Flame,
  HelpCircle,
  Layers,
  ListPlus,
  ListVideo,
  Loader2,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Monitor,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Share2,
  Smartphone,
  Star,
  Subtitles,
  Sun,
  Tv,
  Unlock,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from 'lucide-react';
import { normalizeMovieCardItem } from '../utils/timeAgo';
import type {
  EpisodeItem,
  MovieCardItem,
  MovieDetailData,
  StreamSource,
  WatchlistFolder,
  WatchProgressItem,
} from '../types/cinema';
import {
  getInstantCachedDetail,
  prefetchMovieDetails,
  setVideoStartupPriority,
  stopBackgroundWarmVideo,
  universalApiFetch,
  warmStreamConnection,
} from '../services/liveClientEngine';
import Hls from 'hls.js';
import { IosMkvStreamController } from '../services/mkvIosClientRemuxer';
import {
  buildVttFromCues,
  ensureBanglaTranslationAroundTime,
  fetchOrGenerateAutoBanglaSubtitles,
  findActiveCueTextAtTime,
  loadSubtitleTrackByUrl,
  parseSrtOrVttToCues,
  translateLinesToBangla,
  type AvailableSubtitleTrack,
  type SubtitleCue,
} from '../services/autoBanglaSubtitleEngine';

interface MovieDetailModalProps {
  movie: MovieCardItem | null;
  relatedMovies: MovieCardItem[];
  activeNodeId: string;
  savedProgress?: WatchProgressItem;
  isMiniPlayer?: boolean;
  onToggleMiniPlayer?: (mini: boolean) => void;
  onClose: () => void;
  onSelectMovie: (movie: MovieCardItem) => void;
  isInWatchlist: boolean;
  currentFolder?: WatchlistFolder;
  onToggleWatchlist: (movie: MovieCardItem, folder?: WatchlistFolder) => void;
  onRecordWatchProgress: (
    movie: MovieCardItem,
    episode?: EpisodeItem,
    episodeIdx?: number,
    source?: StreamSource,
    seconds?: number,
    duration?: number
  ) => void;
  onSearchByActor: (actorName: string) => void;
  onOpenReportModal: (prefillTitle: string) => void;
}

const INTRO_SKIP_STORAGE_KEY = 'cp_intro_skip_sec_v3';
const AUTO_NEXT_STORAGE_KEY = 'cp_auto_next_ep_v1';
const BRIGHTNESS_STORAGE_KEY = 'cp_player_brightness_v1';
const AUTO_NET_STORAGE_KEY = 'cp_auto_net_quality_v1';

function formatSeconds(sec: number): string {
  if (!sec || sec < 0 || !isFinite(sec)) return '00:00';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(s).padStart(s < 10 ? 2 : 2, '0')}`;
}

function formatEpisodeTileBadge(ep: EpisodeItem, fallbackIdx: number): string {
  if (ep.id === 'movie-special' || ep.number === 0) return 'Movie';
  const start = ep.rangeStart ?? ep.number;
  const end = ep.rangeEnd ?? ep.number;
  if (start !== null && start !== undefined) {
    const startPad = String(start).padStart(2, '0');
    if (end !== null && end !== undefined && end > start) {
      const endPad = String(end).padStart(2, '0');
      return `${startPad}-${endPad}`;
    }
    return startPad;
  }
  return String(fallbackIdx + 1).padStart(2, '0');
}

function detectIdealQualityForNetwork(): { targetQuality: number; netLabel: string } {
  try {
    const nav = navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (conn) {
      const eff = String(conn.effectiveType || '').toLowerCase();
      const down = Number(conn.downlink || 0);
      const saveData = Boolean(conn.saveData);
      if (saveData || eff === '2g' || eff === 'slow-2g' || eff === '3g' || (down > 0 && down < 4)) {
        return {
          targetQuality: 480,
          netLabel: down > 0 ? `Instant Start (${down}Mbps) · 480p` : 'Instant Start · 480p',
        };
      }
      if (down >= 12) {
        return { targetQuality: 1080, netLabel: `Turbo Auto (${down}Mbps) · 480p→1080p` };
      }
      if (down > 0) {
        return { targetQuality: 720, netLabel: `Turbo Auto (${down}Mbps) · 480p→720p` };
      }
    }
  } catch {
    // ignore
  }
  return { targetQuality: 720, netLabel: 'Turbo Auto · 480p→HD' };
}

/**
 * Instant-Start Source Selector:
 * When opening any movie or episode in Auto mode, ALWAYS pick the lowest bitrate H.264 stream
 * (480p / 360p, or lightweight 720p WEB-DL) first so the video starts playing in < 0.2s without buffering!
 * Once playing smoothly with healthy buffer, the Standby Preloader upgrades to 720p/1080p seamlessly.
 */
function pickBestSourceIndexForNet(sources: StreamSource[], autoNet: boolean): number {
  if (!sources || sources.length === 0) return 0;
  const isDirectStream = (s: StreamSource) =>
    s.type !== 'embed' && !/abyssplayer\.com|vidsrc|\/embed\//i.test(s.url || '');
  const isLightweightH264 = (s: StreamSource) =>
    isDirectStream(s) &&
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '');
  const isAnyDirectH264 = (s: StreamSource) =>
    isDirectStream(s) && !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`);

  if (!autoNet) {
    const firstH264 = sources.findIndex((s) => isLightweightH264(s));
    if (firstH264 !== -1) return firstH264;
    const fallbackH264 = sources.findIndex((s) => isAnyDirectH264(s));
    if (fallbackH264 !== -1) return fallbackH264;
    const anyDirect = sources.findIndex((s) => isDirectStream(s));
    return anyDirect !== -1 ? anyDirect : 0;
  }

  // 1. ALWAYS prefer 480p (360p..576p) H.264 first for 0-delay instant start!
  const h480 = sources.findIndex(
    (s) => isLightweightH264(s) && s.quality >= 360 && s.quality <= 576
  );
  if (h480 !== -1) return h480;

  // 2. Fallback to lightweight 720p H.264 (excluding multi-GB "Best Quality" files)
  const h720 = sources.findIndex((s) => isLightweightH264(s) && s.quality === 720);
  if (h720 !== -1) return h720;

  // 3. Fallback to any lightweight H.264 stream
  const anyLightH264 = sources.findIndex((s) => isLightweightH264(s));
  if (anyLightH264 !== -1) return anyLightH264;

  // 4. Fallback to any direct stream before touching any embed
  const anyDirectH264 = sources.findIndex((s) => isAnyDirectH264(s));
  if (anyDirectH264 !== -1) return anyDirectH264;
  const anyDirect = sources.findIndex((s) => isDirectStream(s));
  return anyDirect !== -1 ? anyDirect : 0;
}

/**
 * Finds the next step-up H.264 resolution (e.g. 480p -> 720p -> 1080p) for progressive smooth upgrade.
 */
function pickNextUpgradeSourceIndex(
  sources: StreamSource[],
  currentQuality: number,
  maxTargetQuality: number,
  failedIndices: number[]
): number {
  if (!sources || sources.length <= 1 || currentQuality >= maxTargetQuality) return -1;
  const isLightweightH264 = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '') &&
    s.type !== 'embed';

  // Step 1: If currently <= 576p (480p), look for 720p first
  if (currentQuality <= 576 && maxTargetQuality >= 720) {
    const idx720 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 720
    );
    if (idx720 !== -1) return idx720;
  }

  // Step 2: If currently <= 720p and network supports 1080p, look for 1080p
  if (currentQuality <= 720 && maxTargetQuality >= 1080) {
    const idx1080 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 1080
    );
    if (idx1080 !== -1) return idx1080;
  }

  return -1;
}

function convertSrtToVtt(srtContent: string): string {
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  if (normalized.trim().startsWith('WEBVTT')) {
    return normalized;
  }
  return `WEBVTT\n\n${normalized}`;
}

function toGatewayAbsoluteUrl(downloadOrStreamUrl: string): string {
  if (!downloadOrStreamUrl) return '';
  if (downloadOrStreamUrl.startsWith('/api/go')) {
    return `${window.location.origin}${downloadOrStreamUrl}`;
  }
  return downloadOrStreamUrl;
}

function isAppleWebKitDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua);
  return isIOS || isSafari;
}

export const MovieDetailModal: React.FC<MovieDetailModalProps> = ({
  movie,
  relatedMovies,
  activeNodeId,
  savedProgress,
  isMiniPlayer = false,
  onToggleMiniPlayer,
  onClose,
  onSelectMovie,
  isInWatchlist,
  currentFolder = 'favorites',
  onToggleWatchlist,
  onRecordWatchProgress,
  onSearchByActor,
  onOpenReportModal,
}) => {
  // Synchronous 0ms detail lookup on Render #1 so <video> mounts immediately inside the user's tap gesture!
  const instantDetailOnRender = useMemo(() => {
    if (!movie) return null;
    return getInstantCachedDetail(movie.path || movie.url, movie.title);
  }, [movie?.path, movie?.url, movie?.title]);

  const [detail, setDetail] = useState<MovieDetailData | null>(() => instantDetailOnRender);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedEpIdx, setSelectedEpIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    return savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
      ? savedProgress.episodeIdx
      : 0;
  });
  const [selectedSourceIdx, setSelectedSourceIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    const initEp =
      savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
        ? eps[savedProgress.episodeIdx]
        : eps[0];
    return pickBestSourceIndexForNet(initEp?.sources || [], true);
  });
  const [selectedSeasonFilter, setSelectedSeasonFilter] = useState<number | 'all'>('all');
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');
  const [episodeSortOrder, setEpisodeSortOrder] = useState<'asc' | 'desc'>('asc');
  const [failedSourceIndices, setFailedSourceIndices] = useState<number[]>([]);
  const [showAllEpisodesModal, setShowAllEpisodesModal] = useState(false);
  const [showDownloadSheet, setShowDownloadSheet] = useState(false);
  const [bottomTab, setBottomTab] = useState<'forYou' | 'infoCast' | 'reviews'>('forYou');

  // MovieBox Audience Reviews & Star Rating State (100% Ad-Free Local Persistence)
  const [userRatingStars, setUserRatingStars] = useState<number>(5);
  const [userReviewName, setUserReviewName] = useState<string>('');
  const [userReviewText, setUserReviewText] = useState<string>('');
  const [customReviewsMap, setCustomReviewsMap] = useState<
    Record<string, Array<{ id: string; author: string; stars: number; text: string; date: string }>>
  >(() => {
    try {
      const raw = localStorage.getItem('cp_moviebox_reviews_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Network-Adaptive Quality Mode (ON by default)
  const [autoNetQuality, setAutoNetQuality] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NET_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [netStatusLabel, setNetStatusLabel] = useState<string>(() => {
    return detectIdealQualityForNetwork().netLabel;
  });
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showAudioServerMenu, setShowAudioServerMenu] = useState<boolean>(false);
  const [showSleepMenu, setShowSleepMenu] = useState<boolean>(false);
  const [sleepTimerMode, setSleepTimerMode] = useState<number | 'end_of_ep' | null>(null);
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number | null>(null);
  const [seekRipple, setSeekRipple] = useState<{
    side: 'left' | 'right';
    delta: number;
    id: number;
  } | null>(null);
  const [scrubPreview, setScrubPreview] = useState<{ sec: number; percent: number } | null>(null);
  const [nextEpPrewarmed, setNextEpPrewarmed] = useState<boolean>(false);

  const [playerMode, setPlayerMode] = useState<'stream' | 'trailer'>('stream');
  const [videoError, setVideoError] = useState(false);
  // Use native continuous <video> streaming on Android/Desktop for zero segment transitions,
  // and Client-Side MP4 Remuxer on iPhone/iPad Safari (or as automatic fallback if native stream errors).
  const [useHlsBridge, setUseHlsBridge] = useState<boolean>(() => isAppleWebKitDevice());
  const [iosBlobUrl, setIosBlobUrl] = useState<string>('');
  const [iosSegmentStartSec, setIosSegmentStartSec] = useState<number>(0);
  const [iosCurrentSegIndex, setIosCurrentSegIndex] = useState<number>(0);
  const iosControllerRef = useRef<IosMkvStreamController | null>(null);
  const iosTransitioningRef = useRef<boolean>(false);
  const hlsInstanceRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [standbyUpgradeIdx, setStandbyUpgradeIdx] = useState<number | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isHold2x, setIsHold2x] = useState(false);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover' | 'fill'>('contain');
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [showOverlayControls, setShowOverlayControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscapeMode, setIsLandscapeMode] = useState(false);
  const [isViewportPortrait, setIsViewportPortrait] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerHeight >= window.innerWidth : true
  );
  const [viewportDims, setViewportDims] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 390,
    height: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));

  // MovieBox Screen Brightness (20% to 160%) & Volume (0% to 100%)
  const [brightness, setBrightness] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY));
      return saved >= 20 && saved <= 160 ? saved : 100;
    } catch {
      return 100;
    }
  });
  const [showBrightnessPanel, setShowBrightnessPanel] = useState(false);
  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [autoMutedForiOS, setAutoMutedForiOS] = useState<boolean>(false);

  // Gesture HUD Indicator (Brightness / Volume / Seek feedback)
  const [hudNotice, setHudNotice] = useState<{
    type: 'brightness' | 'volume' | 'seek' | 'toast';
    label: string;
    percent?: number;
  } | null>(null);

  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedBatch, setCopiedBatch] = useState(false);

  // Automatically mute the 0s..13.5s upstream voice-tag window ("this video downloaded from...")
  const [introSkipSec, setIntroSkipSec] = useState<number>(13.5);

  // Auto-Play Next Episode
  const [autoNextEp, setAutoNextEp] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NEXT_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });

  const [resumedBannerSec, setResumedBannerSec] = useState<number | null>(null);

  // Auto Bangla Subtitle & Custom Subtitle (.SRT / .VTT) State (OFF by default so video starts with zero delay!)
  const [autoBanglaSubEnabled, setAutoBanglaSubEnabled] = useState<boolean>(false);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [loadingAutoSub, setLoadingAutoSub] = useState<boolean>(false);
  const [subFontSize, setSubFontSize] = useState<'sm' | 'md' | 'lg'>('sm');
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string>('');
  const [availableSubTracks, setAvailableSubTracks] = useState<AvailableSubtitleTrack[]>([]);
  const [activeSubTrackIdx, setActiveSubTrackIdx] = useState<number>(0);
  const [subOffsetSec, setSubOffsetSec] = useState<number>(0);
  const [showSubSyncPanel, setShowSubSyncPanel] = useState<boolean>(false);
  const [customSubSearchQuery, setCustomSubSearchQuery] = useState<string>('');
  const [activeBanglaCueText, setActiveBanglaCueText] = useState<string>('');
  const lastRenderedSubTextRef = useRef<string>('');
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);

  const modalContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloadVideoRef = useRef<HTMLVideoElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const isScrubbingRef = useRef<boolean>(false);
  const scrubTargetSecRef = useRef<number>(0);
  const lastTouchSeekTimeRef = useRef<number>(0);
  const isSeekingRef = useRef<boolean>(false);
  const seekReqIdRef = useRef<number>(0);
  const iosSegmentStartSecRef = useRef<number>(0);
  const iosCurrentSegIndexRef = useRef<number>(0);
  const overlayTimerRef = useRef<number | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const rippleTimerRef = useRef<number | null>(null);
  const prewarmedNextEpIdxRef = useRef<number | null>(null);
  const stallDownshiftTimerRef = useRef<number | null>(null);
  const startupWatchdogTimerRef = useRef<number | null>(null);
  const standbyTimeoutRef = useRef<number | null>(null);
  const smoothPlaySecondsRef = useRef<number>(0);
  const hasStalledInSessionRef = useRef<boolean>(false);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });
  const touchGestureRef = useRef<{
    active: boolean;
    side: 'left' | 'right';
    startX: number;
    startY: number;
    startVal: number;
    moved: boolean;
  } | null>(null);
  const lastRecordedSecondRef = useRef<number>(-1);
  const pendingResumeSecRef = useRef<number | null>(null);
  const hasAppliedIntroSkipRef = useRef<boolean>(false);

  // Floating Mini-Player Position & Resizable Width State
  const [miniWidth, setMiniWidth] = useState<number>(250);
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const lastMiniTapTimeRef = useRef<number>(0);
  const miniDragRef = useRef<{
    mode: 'move' | 'resize' | 'pinch';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origWidth: number;
    initialPinchDist: number;
    moved: boolean;
  } | null>(null);

  const triggerHud = (
    type: 'brightness' | 'volume' | 'seek' | 'toast',
    label: string,
    percent?: number,
    timeoutMs = 900
  ) => {
    // Never show any text toast popups over the video player
    if (type === 'toast') return;
    setHudNotice({ type, label, percent });
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      setHudNotice(null);
    }, timeoutMs);
  };

  const resetOverlayAutoHide = () => {
    setShowOverlayControls(true);
    if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = window.setTimeout(() => {
      if (
        videoRef.current &&
        !videoRef.current.paused &&
        !isScrubbing &&
        !showBrightnessPanel &&
        !showQualityMenu &&
        !showAudioServerMenu &&
        !showSleepMenu
      ) {
        setShowOverlayControls(false);
      }
    }, 3600);
  };

  // Sleep Timer Countdown Effect
  useEffect(() => {
    if (typeof sleepTimerMode !== 'number' || sleepRemainingSec === null) return;
    if (sleepRemainingSec <= 0) {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      setSleepTimerMode(null);
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার শেষ হয়েছে — ভিডিও পজ করা হয়েছে', undefined, 3200);
      return;
    }
    const timer = window.setInterval(() => {
      setSleepRemainingSec((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sleepTimerMode, sleepRemainingSec]);

  useEffect(() => {
    try {
      localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness));
    } catch {
      // ignore
    }
  }, [brightness]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NET_STORAGE_KEY, autoNetQuality ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNetQuality]);

  useEffect(() => {
    try {
      localStorage.setItem(INTRO_SKIP_STORAGE_KEY, String(introSkipSec));
    } catch {
      // ignore
    }
  }, [introSkipSec]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NEXT_STORAGE_KEY, autoNextEp ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNextEp]);

  useEffect(() => {
    try {
      localStorage.setItem('cp_auto_bangla_sub_v1', autoBanglaSubEnabled ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoBanglaSubEnabled]);

  useEffect(() => {
    const updateOrientation = () => {
      const w = window.innerWidth || 390;
      const h = window.innerHeight || 844;
      setIsViewportPortrait(h >= w);
      setViewportDims({ width: w, height: h });
    };
    const onFsChange = () => {
      const fsActive = Boolean(
        document.fullscreenElement || (document as any).webkitFullscreenElement
      );
      setIsFullscreen(fsActive);
      updateOrientation();
    };
    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  // Automatically dismiss "Resumed at ..." banner after 1.2 seconds so it never stays stuck
  useEffect(() => {
    if (resumedBannerSec === null) return;
    const timer = window.setTimeout(() => {
      setResumedBannerSec(null);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [resumedBannerSec]);

  useEffect(() => {
    return () => {
      setVideoStartupPriority(false);
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }
      if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      if (stallDownshiftTimerRef.current) window.clearTimeout(stallDownshiftTimerRef.current);
      if (startupWatchdogTimerRef.current) window.clearTimeout(startupWatchdogTimerRef.current);
      if (standbyTimeoutRef.current) window.clearTimeout(standbyTimeoutRef.current);
    };
  }, [subtitleUrl]);

  // Prioritize 100% of network bandwidth for video startup until playback is smoothly underway
  useEffect(() => {
    if (!movie) {
      setVideoStartupPriority(false);
      return;
    }
    const starting = loading || (!hasStartedPlayback && !videoError);
    setVideoStartupPriority(starting);
  }, [movie, loading, hasStartedPlayback, videoError]);

  useEffect(() => {
    if (!movie) return;
    let cancelled = false;
    setVideoStartupPriority(true);
    setError(null);
    setSelectedSeasonFilter('all');
    setEpisodeSearchQuery('');
    setEpisodeSortOrder('asc');
    setFailedSourceIndices([]);
    setUseHlsBridge(isAppleWebKitDevice());
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowDownloadSheet(false);
    setShowAllEpisodesModal(false);
    setCurrentTime(0);
    setBufferedEnd(0);
    setDuration(0);
    setAutoMutedForiOS(false);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const applyResolvedDetail = (resolved: MovieDetailData, isAlreadyMountedInstant = false) => {
      const eps: EpisodeItem[] = resolved.episodes || [];
      const initEpIdx =
        savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
          ? savedProgress.episodeIdx
          : 0;
      const firstEp = eps[initEpIdx];
      const bestSrcIdx = pickBestSourceIndexForNet(firstEp?.sources || [], autoNetQuality);
      const firstSrc = firstEp?.sources?.[bestSrcIdx] || firstEp?.sources?.[0];
      if (firstSrc?.url && firstSrc.type !== 'embed') {
        warmStreamConnection(firstSrc.url);
      }
      if (!isAlreadyMountedInstant) {
        setDetail(resolved);
        setSelectedEpIdx(initEpIdx);
        setSelectedSourceIdx(bestSrcIdx);
      }
    };

    // 1. Synchronous 0ms Instant Check (from static-db.json or prefetched cache):
    // Mount the <video> player immediately on frame 1 with zero extra re-renders!
    const instantCached = getInstantCachedDetail(movie.path || movie.url, movie.title);
    if (instantCached && instantCached.episodes && instantCached.episodes.length > 0) {
      setLoading(false);
      applyResolvedDetail(instantCached, detail === instantCached);
      // Background non-blocking enrich after 2.5s: APPEND any newly discovered servers to the END
      // of the sources list so `sources[selectedSourceIdx]` NEVER changes URL mid-playback!
      const enrichTimer = window.setTimeout(() => {
        if (cancelled) return;
        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
          enrich: '1',
        });
        universalApiFetch(`/api/details?${params.toString()}`)
          .then((data) => {
            if (!cancelled && data?.ok && data?.detail?.episodes?.length) {
              setDetail((prev) => {
                if (!prev || !prev.episodes?.length) return data.detail;
                let addedAny = false;
                const mergedEpisodes = prev.episodes.map((ep, idx) => {
                  const incomingEp = data.detail.episodes?.[idx];
                  if (!incomingEp?.sources?.length) return ep;
                  const existingUrls = new Set((ep.sources || []).map((s) => s.url));
                  const extraSources = incomingEp.sources.filter(
                    (s: StreamSource) => s.url && !existingUrls.has(s.url)
                  );
                  if (extraSources.length === 0) return ep;
                  addedAny = true;
                  return {
                    ...ep,
                    sources: [...(ep.sources || []), ...extraSources],
                  };
                });
                if (data.detail.episodes.length > prev.episodes.length) {
                  const newEpisodes = data.detail.episodes.slice(prev.episodes.length);
                  mergedEpisodes.push(...newEpisodes);
                  addedAny = true;
                }
                return addedAny ? { ...prev, episodes: mergedEpisodes } : prev;
              });
            }
          })
          .catch(() => {});
      }, 2500);
      return () => {
        cancelled = true;
        window.clearTimeout(enrichTimer);
      };
    }

    setLoading(true);
    setDetail(null);
    setSelectedEpIdx(savedProgress?.episodeIdx || 0);
    setSelectedSourceIdx(0);

    const fetchDetail = async () => {
      try {
        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
        });
        const data = await universalApiFetch(`/api/details?${params.toString()}`);
        if (!cancelled) {
          if (data && data.ok && data.detail) {
            applyResolvedDetail(data.detail);
          } else {
            setError('এই মুভিটির বিস্তারিত তথ্য লোড করা যায়নি।');
          }
        }
      } catch {
        if (!cancelled) {
          setError('সার্ভারের সাথে সংযোগ বিচ্ছিন্ন হয়েছে।');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [movie?.path, movie?.url, activeNodeId]);

  const [myflixData, setMyflixData] = useState<{
    embedServers?: Array<{ label: string; url: string }>;
    seasonsData?: Array<{
      index?: number;
      episodes?: Array<{
        index?: number;
        title?: string;
        servers?: Array<{ label?: string; url?: string }>;
      }>;
    }>;
    year?: string;
    genre?: string;
    runtime?: string;
    director?: string;
    release?: string;
    rating?: string;
    screenshots?: string[];
    cast?: Array<{ name: string; role: string; photo: string }>;
    downloads?: Array<{ label: string; url: string }>;
  } | null>(null);
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);
  const [showAllScreenshots, setShowAllScreenshots] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const castScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!movie?.title) {
      setMyflixData(null);
      return;
    }
    let cancelled = false;
    setShowSeasonDropdown(false);
    setShowAllScreenshots(false);
    setLightboxImage(null);
    // Delay metadata enrichment so 100% of network & server priority goes to starting the video first!
    const delayMs =
      (detail?.episodes && detail.episodes.length > 0) ||
      (instantDetailOnRender?.episodes && instantDetailOnRender.episodes.length > 0)
        ? 2500
        : 300;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      universalApiFetch(`/api/myflix?title=${encodeURIComponent(movie.title)}`)
        .then((res) => {
          if (!cancelled && res && res.ok) {
            setMyflixData(res);
          }
        })
        .catch(() => {});
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [movie?.path, movie?.title]);

  // Only pre-warm related seasons & "For you" movies AFTER current video has started playing smoothly (>= 8s)
  useEffect(() => {
    if (!movie || !hasStartedPlayback || currentTime < 8) return;
    const timer = window.setTimeout(() => {
      (detail?.relatedSeasons || []).slice(0, 3).forEach((s) => {
        prefetchMovieDetails(s.path, s.title, activeNodeId);
      });
      relatedMovies.slice(0, 4).forEach((rel) => {
        if (rel.path !== movie.path) {
          prefetchMovieDetails(rel.path, rel.title, activeNodeId);
        }
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [movie, detail?.relatedSeasons, relatedMovies, activeNodeId, hasStartedPlayback, currentTime >= 8]);

  const effectiveDetail = detail || instantDetailOnRender;
  const episodes = useMemo<EpisodeItem[]>(() => {
    if (effectiveDetail?.episodes && effectiveDetail.episodes.length > 0) {
      return effectiveDetail.episodes;
    }
    if (myflixData?.seasonsData && myflixData.seasonsData.length > 0) {
      const built: EpisodeItem[] = [];
      let globalIdx = 0;
      for (const sObj of myflixData.seasonsData) {
        const sNum = Number(sObj?.index) || 1;
        for (const epObj of sObj?.episodes || []) {
          globalIdx++;
          const epNum = Number(epObj?.index) || globalIdx;
          const epTitle = epObj?.title || `Episode ${epNum}`;
          const srvs = (epObj?.servers || []).filter((s) => s?.url);
          if (srvs.length > 0) {
            built.push({
              id: `mf-s${sNum}-e${epNum}`,
              label: `S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • ${epTitle}`,
              number: epNum,
              rangeStart: epNum,
              rangeEnd: epNum,
              season: sNum,
              kind: 'episode',
              sources: srvs.map((srv, idx) => ({
                id: `mf-ep-${sNum}-${epNum}-${idx}`,
                name: srv.label || `Cloud Server ${idx + 1}`,
                quality: 1080,
                qualityLabel: 'Cloud HLS',
                audio: movie?.language || 'Multi Audio',
                audioLanguages: [movie?.language || 'Multi'],
                provider: srv.label || `Cloud Server ${idx + 1}`,
                url: String(srv.url),
                downloadUrl: String(srv.url),
                type: 'embed',
              })),
            });
          }
        }
      }
      if (built.length > 0) return built;
    }
    return [];
  }, [effectiveDetail?.episodes, myflixData?.seasonsData, movie?.language]);

  const activeEpisode: EpisodeItem | undefined = episodes[selectedEpIdx] || episodes[0];
  const sources = useMemo<StreamSource[]>(() => {
    const rawList = activeEpisode?.sources ? [...activeEpisode.sources] : [];
    // Filter out third-party embed iframes (abyssplayer.com etc.) whenever direct ad-free <video> streams exist!
    const directVideoSources = rawList.filter(
      (s) => s.type !== 'embed' && !/abyssplayer\.com|vidsrc|\/embed\//i.test(s.url || '')
    );
    if (directVideoSources.length > 0) {
      return directVideoSources;
    }

    const base = [...rawList];
    const seen = new Set(base.map((s) => s.url));

    // Only fallback to MyFlixBD embed servers if no direct ad-free video streams exist
    if (myflixData?.seasonsData?.length) {
      const flatEpList = myflixData.seasonsData.flatMap((s) => s.episodes || []);
      const matchedMfEp =
        flatEpList.find((e) => Number(e.index) === (activeEpisode?.number || selectedEpIdx + 1)) ||
        flatEpList[selectedEpIdx] ||
        flatEpList[0];
      for (const [idx, srv] of (matchedMfEp?.servers || []).entries()) {
        if (srv?.url && !seen.has(srv.url)) {
          seen.add(srv.url);
          base.push({
            id: `myflix-ep-${idx}`,
            name: srv.label || `Server ${idx + 1}`,
            quality: 1080,
            qualityLabel: '1080p',
            audio: movie?.language || 'Multi Audio',
            audioLanguages: [movie?.language || 'Multi'],
            provider: srv.label || `Server ${idx + 1}`,
            url: srv.url,
            downloadUrl: srv.url,
            type: 'embed',
          });
        }
      }
    }

    if (myflixData?.embedServers?.length) {
      myflixData.embedServers.forEach((srv, idx) => {
        if (srv.url && !seen.has(srv.url)) {
          seen.add(srv.url);
          base.push({
            id: `myflix-${idx}`,
            name: srv.label || `Server ${idx + 1}`,
            quality: 1080,
            qualityLabel: '1080p',
            audio: movie?.language || 'Multi Audio',
            audioLanguages: [movie?.language || 'Multi'],
            provider: srv.label || `Server ${idx + 1}`,
            url: srv.url,
            downloadUrl: srv.url,
            type: 'embed',
          });
        }
      });
    }
    return base;
  }, [activeEpisode?.sources, activeEpisode?.number, selectedEpIdx, myflixData?.seasonsData, myflixData?.embedServers, movie?.language]);
  const activeSource: StreamSource | undefined = sources[selectedSourceIdx] || sources[0];
  const isEmbedSource = Boolean(
    activeSource &&
      (activeSource.type === 'embed' || /abyssplayer\.com|vidsrc|\/embed\//i.test(activeSource.url))
  );

  // Distinct seasons present inside episodes list (e.g. Season 1, Season 2... Season 20)
  const distinctSeasons = useMemo(() => {
    const sSet = new Set<number>();
    episodes.forEach((ep) => {
      if (ep.season !== null && ep.season !== undefined && ep.season > 0) {
        sSet.add(ep.season);
      }
    });
    return Array.from(sSet).sort((a, b) => a - b);
  }, [episodes]);

  // Filtered & sorted episodes with original index preserved
  const filteredEpisodesWithIdx = useMemo(() => {
    const base = episodes.map((ep, idx) => ({ ep, idx }));
    const bySeason =
      selectedSeasonFilter === 'all'
        ? base
        : base.filter((x) => x.ep.season === selectedSeasonFilter);

    const q = episodeSearchQuery.trim().toLowerCase();
    const matched = !q
      ? bySeason
      : bySeason.filter(({ ep, idx }) => {
          const badge = formatEpisodeTileBadge(ep, idx).toLowerCase();
          const lbl = ep.label.toLowerCase();
          return badge.includes(q) || lbl.includes(q);
        });

    return episodeSortOrder === 'desc' ? [...matched].reverse() : matched;
  }, [episodes, selectedSeasonFilter, episodeSearchQuery, episodeSortOrder]);

  // Automatic Synchronized Bangla Subtitle Resolver — Starts 700ms after movie opens
  // using effectiveDetail so both instant-cached and live-fetched titles resolve Bangla subtitles!
  useEffect(() => {
    if (!movie || !autoBanglaSubEnabled) return;
    let cancelled = false;

    const subDelayTimer = window.setTimeout(() => {
      if (cancelled) return;

      // Fast-path: check if our Micro-Chunk MKV remuxer already extracted embedded subtitles from RAM!
      const inMemoryMkvSubs = iosControllerRef.current?.getExtractedSubtitles() || [];
      if (inMemoryMkvSubs.length >= 8) {
        const mappedCues: SubtitleCue[] = inMemoryMkvSubs.map((s) => ({
          startSec: s.ptsMs / 1000,
          endSec: s.endPtsMs / 1000,
          text: s.text,
        }));
        ensureBanglaTranslationAroundTime(mappedCues, Math.max(0, currentTime - subOffsetSec))
          .then(() => {
            if (cancelled) return;
            const vttText = buildVttFromCues(mappedCues);
            const blob = new Blob([vttText], { type: 'text/vtt' });
            setSubtitleCues(mappedCues);
            setSubtitleUrl(URL.createObjectURL(blob));
            setSubtitleName('বাংলা Sub (Embedded Sync)');
          })
          .catch(() => {});
        return;
      }

      setLoadingAutoSub(true);
      const isSeriesItem = Boolean(
        episodes.length > 1 ||
          movie.typeBadge === 'SERIES' ||
          /\b(season|episode|ep\s*\d+|s\d+)\b/i.test(
            `${effectiveDetail?.title || movie.title} ${activeEpisode?.label || ''}`
          )
      );
      const resolvedSeason =
        activeEpisode?.season && activeEpisode.season > 0
          ? activeEpisode.season
          : isSeriesItem
            ? selectedSeasonFilter !== 'all'
              ? Number(selectedSeasonFilter)
              : distinctSeasons[0] || 1
            : undefined;
      const resolvedEpisode =
        activeEpisode?.number && activeEpisode.number > 0
          ? activeEpisode.number
          : isSeriesItem
            ? selectedEpIdx + 1
            : undefined;

      fetchOrGenerateAutoBanglaSubtitles({
        moviePath: movie.path || movie.url,
        title: effectiveDetail?.title || movie.title,
        storyline: effectiveDetail?.storyline || '',
        episodeLabel: activeEpisode?.label || '',
        season: resolvedSeason,
        episode: resolvedEpisode,
        language: effectiveDetail?.language || movie.language,
        streamUrl: activeSource?.url,
        streamName: `${activeSource?.name || ''} ${activeSource?.qualityLabel || ''} ${effectiveDetail?.quality || movie.quality || ''}`,
        videoDurationSec: duration || undefined,
        currentTimeSec: Math.max(0, currentTime - subOffsetSec),
      })
        .then((res) => {
          if (cancelled) return;
          setSubtitleCues(res.cues);
          setSubtitleUrl(res.vttBlobUrl);
          setSubtitleName(res.sourceLabel);
          setAvailableSubTracks(res.availableTracks || []);
          setActiveSubTrackIdx(res.activeTrackIndex || 0);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingAutoSub(false);
        });
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(subDelayTimer);
    };
  }, [
    movie?.path,
    effectiveDetail?.title,
    selectedEpIdx,
    activeEpisode?.label,
    autoBanglaSubEnabled,
    hasStartedPlayback,
  ]);

  // Advance playhead clock when playing an embed source so Bangla subtitles stay active on Cloud HLS too
  useEffect(() => {
    if (!movie || !isEmbedSource || !autoBanglaSubEnabled) return;
    const t = window.setInterval(() => {
      setCurrentTime((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [movie?.path, isEmbedSource, autoBanglaSubEnabled, selectedEpIdx, selectedSourceIdx]);

  // Live Windowed Bengali Translation around the viewer's current playback timestamp (even after seeking!)
  const translationBucket = Math.floor(Math.max(0, currentTime - subOffsetSec) / 6);
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) return;
    let cancelled = false;
    const v = videoRef.current;
    const exactNow =
      v && !isEmbedSource
        ? useHlsBridge
          ? iosSegmentStartSec + v.currentTime
          : v.currentTime
        : currentTime;
    const effectiveTime = Math.max(0, exactNow - subOffsetSec);
    ensureBanglaTranslationAroundTime(subtitleCues, effectiveTime, (updated) => {
      if (!cancelled) {
        setSubtitleCues(updated);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    autoBanglaSubEnabled,
    subtitleCues.length,
    translationBucket,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
    isEmbedSource,
  ]);

  // Frame-Accurate 55ms Floating-Point Subtitle Sync Ticker:
  // Reads exact float `videoRef.current.currentTime` (instead of 1s floored integer) so Bengali subtitles
  // appear & disappear at the exact millisecond the actor speaks, with zero unnecessary React re-renders!
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) {
      if (lastRenderedSubTextRef.current !== '') {
        lastRenderedSubTextRef.current = '';
        setActiveBanglaCueText('');
      }
      return;
    }

    const syncSubToExactVoiceTime = () => {
      const v = videoRef.current;
      const rawPlayhead =
        v && !isEmbedSource
          ? useHlsBridge
            ? iosSegmentStartSec + v.currentTime
            : v.currentTime
          : currentTime;
      const effectiveTimeSec = Math.max(0, rawPlayhead - subOffsetSec);
      const nextCueText = findActiveCueTextAtTime(subtitleCues, effectiveTimeSec);
      if (nextCueText !== lastRenderedSubTextRef.current) {
        lastRenderedSubTextRef.current = nextCueText;
        setActiveBanglaCueText(nextCueText);
      }
    };

    syncSubToExactVoiceTime();
    const timer = window.setInterval(syncSubToExactVoiceTime, 55);
    return () => window.clearInterval(timer);
  }, [
    autoBanglaSubEnabled,
    subtitleCues,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
    isEmbedSource,
    currentTime,
  ]);

  // Client-Side In-Browser Turbo Micro-Chunk MKV-to-MP4 Engine (700KB Instant Start + 650KB Exact Cues Seek)
  useEffect(() => {
    const rawUrl = activeSource?.url || '';
    const isAlreadyNativeMp4 = /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl);

    if (!useHlsBridge || !rawUrl || isAlreadyNativeMp4 || isEmbedSource) {
      if (iosControllerRef.current) {
        iosControllerRef.current.destroy();
        iosControllerRef.current = null;
      }
      isSeekingRef.current = false;
      iosSegmentStartSecRef.current = 0;
      iosCurrentSegIndexRef.current = 0;
      setIosBlobUrl('');
      setIosSegmentStartSec(0);
      setIosCurrentSegIndex(0);
      return;
    }

    if (iosControllerRef.current) {
      iosControllerRef.current.destroy();
      iosControllerRef.current = null;
    }

    // Compute any initial resume timestamp BEFORE starting the controller so it jumps straight
    // to the resumed CuePoint in a single fetch, and immediately lock `hasAppliedIntroSkipRef`
    // so live-updating `savedProgress` NEVER re-triggers a backward jump mid-playback!
    const initialResumeTarget =
      pendingResumeSecRef.current && pendingResumeSecRef.current > 3
        ? pendingResumeSecRef.current
        : !hasAppliedIntroSkipRef.current &&
            savedProgress &&
            (savedProgress.episodeIdx === undefined ||
              savedProgress.episodeIdx === selectedEpIdx) &&
            savedProgress.progressSeconds &&
            savedProgress.progressSeconds > 20
          ? savedProgress.progressSeconds
          : 0;

    hasAppliedIntroSkipRef.current = true;
    if (initialResumeTarget > 3) {
      pendingResumeSecRef.current = null;
    }

    const ctrl = new IosMkvStreamController(rawUrl, introSkipSec, initialResumeTarget);
    iosControllerRef.current = ctrl;
    iosTransitioningRef.current = false;
    isSeekingRef.current = false;
    iosSegmentStartSecRef.current = 0;
    iosCurrentSegIndexRef.current = 0;
    setIosBlobUrl('');
    setIosSegmentStartSec(0);
    setIosCurrentSegIndex(0);
    setVideoError(false);
    setIsBuffering(true);

    ctrl
      .startInitialSegment()
      .then(async (seg0) => {
        if (iosControllerRef.current !== ctrl) return;
        const totalDur = ctrl.getTotalDurationSec();
        if (totalDur > 0) {
          setDuration(Math.floor(totalDur));
        }

        iosCurrentSegIndexRef.current = seg0.index;
        iosSegmentStartSecRef.current = seg0.startSec;
        lastRecordedSecondRef.current = Math.floor(seg0.startSec);
        setIosCurrentSegIndex(seg0.index);
        setIosSegmentStartSec(seg0.startSec);
        setIosBlobUrl(seg0.blobUrl);
        setCurrentTime(Math.floor(seg0.startSec));
        if (initialResumeTarget > 20 && seg0.startSec >= 18) {
          setResumedBannerSec(Math.floor(seg0.startSec));
        }
        setIsBuffering(false);
      })
      .catch(() => {
        if (iosControllerRef.current !== ctrl) return;
        // Try next available H.264 stream source if current source fails
        const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
        setFailedSourceIndices(nextFailed);
        const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
        if (nextCandidateIdx !== -1) {
          setSelectedSourceIdx(nextCandidateIdx);
          return;
        }
        // If all sources are AV1/HEVC and device is Chrome/Android (non-WebKit), fall back to native <video> MKV playback!
        if (!isAppleWebKitDevice()) {
          setUseHlsBridge(false);
          setFailedSourceIndices([]);
          setSelectedSourceIdx(0);
          return;
        }
        setIsBuffering(false);
        setVideoError(true);
      });

    return () => {
      if (iosControllerRef.current === ctrl) {
        ctrl.destroy();
        iosControllerRef.current = null;
      }
    };
  }, [activeSource?.url, useHlsBridge]);

  const effectiveVideoUrl = useMemo(() => {
    const rawUrl = activeSource?.url || '';
    if (!rawUrl) return '';
    const isAlreadyNativeMp4 = /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl);
    if (useHlsBridge && !isAlreadyNativeMp4 && !isEmbedSource) {
      return iosBlobUrl;
    }
    return rawUrl;
  }, [activeSource?.url, useHlsBridge, iosBlobUrl, isEmbedSource]);

  // Immediately trigger native video.play() inside useLayoutEffect (preserving user tap gesture!)
  // and only show buffering spinner if the stream takes > 600ms so instant streams never flash a spinner!
  useLayoutEffect(() => {
    stopBackgroundWarmVideo();
    if (!effectiveVideoUrl) {
      if (!useHlsBridge) setIsBuffering(false);
      return;
    }
    setVideoError(false);
    setIsBuffering(false);

    const v = videoRef.current;
    if (v && !isEmbedSource) {
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
      const isM3u8 = /\.m3u8(\?|$)/i.test(effectiveVideoUrl);
      if (isM3u8 && Hls.isSupported() && !v.canPlayType('application/vnd.apple.mpegurl')) {
        const hls = new Hls({
          enableWorker: true,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          startFragPrefetch: true,
        });
        hlsInstanceRef.current = hls;
        hls.loadSource(effectiveVideoUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          syncCleanAudioVolume(v);
          v.play().catch(() => {});
        });
      } else {
        syncCleanAudioVolume(v);
        const p = v.play();
        if (p !== undefined) {
          p.catch((err: any) => {
            if (err && err.name === 'NotAllowedError') {
              v.muted = true;
              setIsMuted(true);
              setAutoMutedForiOS(true);
              v.play().catch(() => {});
            }
          });
        }
      }
    }

    const bufTimer = window.setTimeout(() => {
      const curV = videoRef.current;
      if (curV && curV.readyState < 2 && !curV.paused) {
        setIsBuffering(true);
      }
    }, 600);

    return () => {
      window.clearTimeout(bufTimer);
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    };
  }, [effectiveVideoUrl, useHlsBridge, isEmbedSource]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    }
  }, [playbackSpeed, isHold2x]);

  // High-frequency 80ms audio gate during the opening 16s so the 0s..13.5s voice tag is 100% silent
  // from millisecond 0 and unmutes cleanly the instant the voice tag ends!
  useEffect(() => {
    if (!movie || isEmbedSource || currentTime > 16) return;
    if (videoRef.current) {
      syncCleanAudioVolume(videoRef.current);
    }
    const timer = window.setInterval(() => {
      if (videoRef.current) {
        syncCleanAudioVolume(videoRef.current);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [movie?.path, isEmbedSource, currentTime <= 16, isMuted, volume, introSkipSec, useHlsBridge]);

  // Keyboard Shortcuts (Space/K = Play/Pause, ArrowLeft/Right = +-10s, M = Mute, F = Fullscreen)
  useEffect(() => {
    if (!movie) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) {
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSeekRelative(10);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSeekRelative(-10);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setIsMuted((prev) => {
          const next = !prev;
          if (videoRef.current) videoRef.current.muted = next;
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [movie, currentTime, duration]);

  // Listen to network speed changes only to update the status label (never tear down the active video mid-play!)
  useEffect(() => {
    if (!movie) return;
    const nav = navigator as any;
    const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
    if (!conn || !conn.addEventListener) return;

    const onNetworkChange = () => {
      const detected = detectIdealQualityForNetwork();
      setNetStatusLabel(detected.netLabel);
    };

    conn.addEventListener('change', onNetworkChange);
    return () => {
      conn.removeEventListener('change', onNetworkChange);
    };
  }, [movie]);

  if (!movie) return null;

  const advanceToNextIosSegment = async (): Promise<boolean> => {
    const ctrl = iosControllerRef.current;
    if (!ctrl || iosTransitioningRef.current || isSeekingRef.current) return false;
    iosTransitioningRef.current = true;
    try {
      const nextSeg = await ctrl.ensureNextSegmentPrebuffered(iosCurrentSegIndexRef.current + 1);
      if (nextSeg && iosControllerRef.current === ctrl && !isSeekingRef.current) {
        const monotonicStartSec = Math.max(
          iosSegmentStartSecRef.current,
          lastRecordedSecondRef.current,
          nextSeg.startSec
        );
        pendingResumeSecRef.current = null;
        iosCurrentSegIndexRef.current = nextSeg.index;
        iosSegmentStartSecRef.current = monotonicStartSec;
        setIosCurrentSegIndex(nextSeg.index);
        setIosSegmentStartSec(monotonicStartSec);
        setIosBlobUrl(nextSeg.blobUrl);
        ctrl.ensureNextSegmentPrebuffered(nextSeg.index + 1);
        return true;
      }
      return false;
    } finally {
      iosTransitioningRef.current = false;
    }
  };

  const seekVideoToGlobalTime = (targetGlobalSec: number) => {
    const v = videoRef.current;
    const ctrlDur = iosControllerRef.current?.getTotalDurationSec() || 0;
    const maxDur =
      ctrlDur > 0
        ? ctrlDur
        : duration > 0
          ? duration
          : !useHlsBridge && v?.duration
            ? v.duration
            : 99999;
    const clamped = Math.max(0, Math.min(maxDur - 1, targetGlobalSec));
    const roundedTarget = Math.floor(clamped);
    lastRecordedSecondRef.current = roundedTarget;
    setCurrentTime(roundedTarget);
    resetOverlayAutoHide();

    if (!useHlsBridge || !iosControllerRef.current) {
      if (v) {
        isSeekingRef.current = true;
        try {
          v.currentTime = clamped;
          if (v.paused) v.play().catch(() => {});
        } catch {
          // ignore
        }
        window.setTimeout(() => {
          isSeekingRef.current = false;
        }, 550);
      }
      return;
    }

    const segStart = iosSegmentStartSecRef.current;
    const segDur = v?.duration || 0;
    if (
      v &&
      !isSeekingRef.current &&
      segDur > 1 &&
      clamped >= segStart &&
      clamped < segStart + segDur - 0.6
    ) {
      try {
        v.currentTime = Math.max(0, clamped - segStart);
        if (v.paused) v.play().catch(() => {});
      } catch {
        // ignore
      }
      return;
    }

    const ctrl = iosControllerRef.current;
    const reqId = ++seekReqIdRef.current;
    isSeekingRef.current = true;
    setIsBuffering(true);
    // Pause old segment immediately so it never fires onTimeUpdate or onEnded with the old timestamp while seeking!
    if (v && !v.paused) {
      try {
        v.pause();
      } catch {
        // ignore
      }
    }

    ctrl.seekToSeconds(clamped).then((seekSeg) => {
      if (iosControllerRef.current !== ctrl || seekReqIdRef.current !== reqId) return;
      const latestTotal = ctrl.getTotalDurationSec();
      if (latestTotal > 0 && Math.floor(latestTotal) !== duration) {
        setDuration(Math.floor(latestTotal));
      }
      if (seekSeg) {
        const offsetInsideSeg = Math.max(
          0,
          Math.min((seekSeg.durationSec || 10) - 0.5, clamped - seekSeg.startSec)
        );
        const exactDisplaySec = Math.floor(seekSeg.startSec + offsetInsideSeg);
        iosCurrentSegIndexRef.current = seekSeg.index;
        iosSegmentStartSecRef.current = seekSeg.startSec;
        lastRecordedSecondRef.current = exactDisplaySec;
        pendingResumeSecRef.current = offsetInsideSeg > 0.35 ? offsetInsideSeg : null;
        setIosCurrentSegIndex(seekSeg.index);
        setIosSegmentStartSec(seekSeg.startSec);
        setIosBlobUrl(seekSeg.blobUrl);
        setCurrentTime(exactDisplaySec);
        window.setTimeout(() => {
          if (seekReqIdRef.current === reqId) {
            isSeekingRef.current = false;
          }
        }, 750);
      } else {
        isSeekingRef.current = false;
        if (v && v.paused) {
          v.play().catch(() => {});
        }
      }
      setIsBuffering(false);
    });
  };

  const handleSelectEpisode = (idx: number) => {
    setSelectedEpIdx(idx);
    const ep = episodes[idx];
    const bestSrcIdx = pickBestSourceIndexForNet(ep?.sources || [], autoNetQuality);
    setSelectedSourceIdx(bestSrcIdx);
    setFailedSourceIndices([]);
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowAllEpisodesModal(false);
    setNextEpPrewarmed(false);
    prewarmedNextEpIdxRef.current = null;
    isSeekingRef.current = false;
    iosSegmentStartSecRef.current = 0;
    iosCurrentSegIndexRef.current = 0;
    setCurrentTime(0);
    setBufferedEnd(0);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    const src = ep?.sources?.[bestSrcIdx] || ep?.sources?.[0];
    if (src?.url && src.type !== 'embed') {
      warmStreamConnection(src.url);
    }
    onRecordWatchProgress(movie, ep, idx, src, 0);
  };

  const handleSelectSource = (idx: number, isManualChoice = false) => {
    if (currentTime > 3) {
      pendingResumeSecRef.current = currentTime;
    }
    if (isManualChoice) {
      setAutoNetQuality(false);
      setStandbyUpgradeIdx(null);
    }
    smoothPlaySecondsRef.current = 0;
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    setSelectedSourceIdx(idx);
    setPlayerMode('stream');
    setVideoError(false);
    const src = sources[idx];
    onRecordWatchProgress(movie, activeEpisode, selectedEpIdx, src, currentTime);
    triggerHud(
      'toast',
      isManualChoice
        ? `⚡ সার্ভার সুইচ: ${src?.audioLanguages?.join('+') || src?.audio || 'Audio'} · ${src?.quality || 720}p চালু হয়েছে`
        : `অটো কোয়ালিটি: ${src?.quality || 480}p চালু হয়েছে`
    );
  };

  const handleEnableAutoQuality = () => {
    setAutoNetQuality(true);
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    hasStalledInSessionRef.current = false;
    smoothPlaySecondsRef.current = 0;
    const detected = detectIdealQualityForNetwork();
    setNetStatusLabel(detected.netLabel);
    if (sources.length > 0) {
      const bestIdx = pickBestSourceIndexForNet(sources, true);
      if (bestIdx !== selectedSourceIdx) {
        handleSelectSource(bestIdx, false);
      } else {
        triggerHud(
          'toast',
          `অটো কোয়ালিটি চালু: ইনস্ট্যান্ট ${sources[bestIdx]?.quality || 480}p → স্মুথ HD আপগ্রেড`
        );
      }
    }
  };

  const handleSetSleepTimer = (mode: number | 'end_of_ep' | null) => {
    setSleepTimerMode(mode);
    setShowSleepMenu(false);
    if (mode === null) {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার বন্ধ করা হয়েছে');
    } else if (mode === 'end_of_ep') {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 এই এপিসোড শেষ হলে অটোমেটিক ভিডিও বন্ধ হবে');
    } else {
      setSleepRemainingSec(mode * 60);
      triggerHud('toast', `🌙 স্লিপ টাইমার চালু: ${mode} মিনিট পর অটো পজ হবে`);
    }
  };

  const startVideoWithiOSFallback = (v: HTMLVideoElement) => {
    if (!v.paused) return;
    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch((err: any) => {
        // Only fall back to muted autoplay if browser explicitly blocked unmuted autoplay (NotAllowedError)
        if (err && err.name === 'NotAllowedError') {
          v.muted = true;
          setIsMuted(true);
          setAutoMutedForiOS(true);
          v.play().catch(() => {
            setIsBuffering(false);
            setShowOverlayControls(true);
          });
        }
      });
    }
  };

  // Enforces 0% volume & muted state during the 0s..13.5s upstream voice-tag window
  // so external site audio tags ("this video downloaded from...") NEVER play on any device!
  const syncCleanAudioVolume = (v: HTMLVideoElement) => {
    const dur = duration || v.duration || 0;
    const globalTime = useHlsBridge ? iosSegmentStartSecRef.current + v.currentTime : v.currentTime;
    const muteWindowSec = Math.max(13.5, introSkipSec);
    const inVoiceTagWindow =
      globalTime < muteWindowSec &&
      (!dur || dur > muteWindowSec + 25);

    if (isMuted || inVoiceTagWindow) {
      v.volume = 0;
      v.muted = true;
    } else {
      v.volume = Math.max(0, Math.min(1, volume / 100));
      v.muted = false;
    }
  };

  const handleVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    v.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    try {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = 'disabled';
      }
    } catch {
      // ignore
    }
    const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
    if (totalFromCtrl > 0) {
      setDuration(Math.floor(totalFromCtrl));
    } else if (!useHlsBridge && v.duration > 0) {
      setDuration(Math.floor(v.duration));
    }
    setHasStartedPlayback(true);
    setIsBuffering(false);

    // Silence any upstream intro audio tag immediately before first frame plays
    syncCleanAudioVolume(v);

    if (useHlsBridge) {
      if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 0.3) {
        const localOffset = pendingResumeSecRef.current;
        pendingResumeSecRef.current = null;
        try {
          v.currentTime = Math.min(Math.max(0, (v.duration || 12) - 0.4), localOffset);
        } catch {
          // ignore
        }
      }
      isSeekingRef.current = false;
      startVideoWithiOSFallback(v);
      return;
    }

    // 1. If switching resolution mid-playback, restore exact timestamp
    if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 2) {
      const target = pendingResumeSecRef.current;
      pendingResumeSecRef.current = null;
      try {
        v.currentTime = target;
      } catch {
        // ignore
      }
      isSeekingRef.current = false;
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    // 2. If user has saved watch history for this episode on initial open, resume ONCE automatically,
    // and lock `hasAppliedIntroSkipRef.current = true` unconditionally so subsequent buffering/metadata events NEVER rewind!
    const canResumeSaved =
      !hasAppliedIntroSkipRef.current &&
      currentTime < 3 &&
      lastRecordedSecondRef.current < 3 &&
      savedProgress &&
      (savedProgress.episodeIdx === undefined || savedProgress.episodeIdx === selectedEpIdx) &&
      savedProgress.progressSeconds &&
      savedProgress.progressSeconds > 15 &&
      (!v.duration || savedProgress.progressSeconds < v.duration - 20);

    hasAppliedIntroSkipRef.current = true;

    if (canResumeSaved && savedProgress?.progressSeconds) {
      try {
        v.currentTime = savedProgress.progressSeconds;
        lastRecordedSecondRef.current = Math.floor(savedProgress.progressSeconds);
        setCurrentTime(savedProgress.progressSeconds);
        setResumedBannerSec(savedProgress.progressSeconds);
      } catch {
        // ignore
      }
      isSeekingRef.current = false;
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    isSeekingRef.current = false;
    syncCleanAudioVolume(v);
    startVideoWithiOSFallback(v);
  };

  const handleVideoError = () => {
    const resumeAt = Math.max(currentTime, lastRecordedSecondRef.current);
    // 1. Automatically fall back to next available H.264 stream (e.g. 720p or 480p) if current source fails
    const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
    setFailedSourceIndices(nextFailed);

    const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
    if (nextCandidateIdx !== -1) {
      if (resumeAt > 3) {
        pendingResumeSecRef.current = resumeAt;
      }
      setSelectedSourceIdx(nextCandidateIdx);
      setVideoError(false);
      return;
    }

    // 2. If direct native MKV playback failed on all sources, switch to our client-side MP4 remux engine!
    if (!useHlsBridge) {
      if (resumeAt > 3) {
        pendingResumeSecRef.current = resumeAt;
      }
      setUseHlsBridge(true);
      setFailedSourceIndices([]);
      setSelectedSourceIdx(pickBestSourceIndexForNet(sources, true));
      setVideoError(false);
      return;
    }

    setIsBuffering(false);
    setVideoError(true);
  };

  const handleTogglePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
    resetOverlayAutoHide();
  };

  const handleSeekRelative = (deltaSec: number) => {
    const baseTime = currentTime || videoRef.current?.currentTime || 0;
    seekVideoToGlobalTime(baseTime + deltaSec);
    setSeekRipple({
      side: deltaSec < 0 ? 'left' : 'right',
      delta: deltaSec,
      id: Date.now(),
    });
    if (rippleTimerRef.current) window.clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = window.setTimeout(() => {
      setSeekRipple(null);
    }, 680);
    triggerHud('seek', deltaSec > 0 ? `+${deltaSec}s Forward` : `${deltaSec}s Rewind`);
    resetOverlayAutoHide();
  };

  const handleToggleMute = () => {
    const v = videoRef.current;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (v) v.muted = nextMuted;
    triggerHud('volume', nextMuted ? 'Muted' : `Volume ${volume}%`, nextMuted ? 0 : volume);
  };

  const handleChangeBrightness = (newVal: number) => {
    const clamped = Math.max(20, Math.min(160, Math.round(newVal)));
    setBrightness(clamped);
    triggerHud('brightness', `Brightness ${clamped}%`, Math.round(((clamped - 20) / 140) * 100));
  };

  const handleCycleVideoFit = () => {
    const nextFit =
      videoFit === 'contain' ? 'cover' : videoFit === 'cover' ? 'fill' : 'contain';
    setVideoFit(nextFit);
    triggerHud(
      'toast',
      nextFit === 'contain'
        ? 'Screen Fit: Original'
        : nextFit === 'cover'
          ? 'Screen Fit: Zoom Crop'
          : 'Screen Fit: Full Stretch'
    );
  };

  const handleTogglePiP = async () => {
    // Prefer In-App Floating Mini Player so the user can browse the app while watching!
    if (onToggleMiniPlayer && !isLandscapeMode && !isFullscreen) {
      onToggleMiniPlayer(!isMiniPlayer);
      return;
    }
    const v = videoRef.current as any;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSupportsPresentationMode && v.webkitSetPresentationMode) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
        );
      }
    } catch {
      // ignore
    }
  };

  const handleToggleFullscreen = () => {
    const stage = playerStageRef.current as any;
    const currentFs = document.fullscreenElement || (document as any).webkitFullscreenElement;
    const currentlyActive = isLandscapeMode || isFullscreen || Boolean(currentFs);

    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    setIsViewportPortrait(h >= w);
    setViewportDims({ width: w, height: h });

    if (currentlyActive) {
      setIsLandscapeMode(false);
      setIsFullscreen(false);
      try {
        if (currentFs) {
          if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          } else if ((document as any).webkitExitFullscreen) {
            (document as any).webkitExitFullscreen();
          }
        }
        if ((screen.orientation as any)?.unlock) {
          (screen.orientation as any).unlock();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (isMiniPlayer && onToggleMiniPlayer) {
      onToggleMiniPlayer(false);
    }

    // Activate Fullscreen + 90-deg Landscape Rotation Mode immediately
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0 });
    }
    setIsLandscapeMode(true);
    setIsFullscreen(true);
    resetOverlayAutoHide();

    try {
      if (stage && stage.requestFullscreen) {
        stage
          .requestFullscreen()
          .then(() => {
            if ((screen.orientation as any)?.lock) {
              (screen.orientation as any).lock('landscape').catch(() => {});
            }
          })
          .catch(() => {});
      } else if (stage && stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
      }
    } catch {
      // CSS 90deg landscape rotation on the inner stage wrapper handles portrait screens automatically
    }
  };

  // Touch Gesture Handlers on Video Stage (Left vertical swipe = Brightness, Right vertical swipe = Volume, Double tap = +-10s, Long press = 2x Speed)
  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isMiniPlayer || isScreenLocked || playerMode === 'trailer') return;
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const isLeftHalf = isRotated90
      ? touch.clientY - rect.top < rect.height / 2
      : touch.clientX - rect.left < rect.width / 2;

    touchGestureRef.current = {
      active: true,
      side: isLeftHalf ? 'left' : 'right',
      startX: touch.clientX,
      startY: touch.clientY,
      // Left side = Sound (Volume), Right side = Brightness
      startVal: isLeftHalf ? (isMuted ? 0 : volume) : brightness,
      moved: false,
    };

    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      if (touchGestureRef.current && !touchGestureRef.current.moved && isPlaying) {
        setIsHold2x(true);
      }
    }, 500);
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = touchGestureRef.current;
    if (!g || !g.active || isMiniPlayer || isScreenLocked || e.touches.length !== 1) return;

    const touch = e.touches[0];
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const dx = isRotated90 ? touch.clientY - g.startY : touch.clientX - g.startX;
    const dy = isRotated90 ? touch.clientX - g.startX : g.startY - touch.clientY;

    if (!g.moved) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        g.active = false;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        return;
      }
      if (Math.abs(dy) > 8) {
        g.moved = true;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        setIsHold2x(false);
      } else {
        return;
      }
    }

    if (g.side === 'right') {
      // Right side swipe up/down -> Brightness increase/decrease (20% to 160%)
      const deltaBrightness = Math.round(dy * 0.75);
      const nextB = Math.max(20, Math.min(160, g.startVal + deltaBrightness));
      setBrightness(nextB);
      try {
        localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(nextB));
      } catch {
        // ignore
      }
      triggerHud(
        'brightness',
        `Brightness ${nextB}%`,
        Math.round(((nextB - 20) / 140) * 100),
        650
      );
    } else {
      // Left side swipe up/down -> Sound / Volume increase/decrease (0% to 100%)
      const deltaVol = Math.round(dy * 0.65);
      const nextV = Math.max(0, Math.min(100, g.startVal + deltaVol));
      setVolume(nextV);
      setIsMuted(nextV === 0);
      if (videoRef.current) {
        videoRef.current.volume = nextV / 100;
        videoRef.current.muted = nextV === 0;
      }
      triggerHud('volume', nextV === 0 ? 'Muted' : `Sound ${nextV}%`, nextV, 650);
    }
  };

  const handleStageTouchEnd = () => {
    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    if (isHold2x) {
      setIsHold2x(false);
    }
    touchGestureRef.current = null;
  };

  const clampMiniPosition = (x: number, y: number, widthVal: number) => {
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const heightVal = Math.round((widthVal * 9) / 16);
    const maxX = Math.max(8, vw - widthVal - 8);
    const maxY = Math.max(8, vh - heightVal - 8);
    return {
      x: Math.max(8, Math.min(maxX, Math.round(x))),
      y: Math.max(8, Math.min(maxY, Math.round(y))),
    };
  };

  const clampMiniWidthVal = (w: number) => {
    const vw = window.innerWidth || 390;
    const maxW = Math.min(370, Math.max(220, vw - 16));
    return Math.max(165, Math.min(maxW, Math.round(w)));
  };

  const handleCycleMiniSize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const vw = window.innerWidth || 390;
    const maxW = Math.min(350, Math.max(240, vw - 20));
    const nextW = miniWidth < 215 ? 255 : miniWidth < 295 ? maxW : 185;
    const clampedW = clampMiniWidthVal(nextW);
    setMiniWidth(clampedW);
    if (miniPos) {
      setMiniPos(clampMiniPosition(miniPos.x, miniPos.y, clampedW));
    }
  };

  const handleMiniTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      miniDragRef.current = {
        mode: 'pinch',
        startX: 0,
        startY: 0,
        origX: rect.left,
        origY: rect.top,
        origWidth: miniWidth,
        initialPinchDist: Math.max(24, Math.hypot(dx, dy)),
        moved: true,
      };
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: touch.clientX,
      startY: touch.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };
  };

  const handleMiniTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const g = miniDragRef.current;
    if (!g) return;

    if (g.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.max(24, Math.hypot(dx, dy));
      const nextW = clampMiniWidthVal(g.origWidth * (dist / g.initialPinchDist));
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;

    if (g.mode === 'resize') {
      const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
      const nextW = clampMiniWidthVal(g.origWidth + deltaW);
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (!g.moved && Math.hypot(dx, dy) > 7) {
      g.moved = true;
    }

    if (g.moved) {
      setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
    }
  };

  const handleMiniTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (
      target.closest('[data-mini-close="true"]') ||
      target.closest('[data-mini-cycle="true"]') ||
      target.closest('[data-mini-resize="true"]')
    ) {
      miniDragRef.current = null;
      return;
    }
    const g = miniDragRef.current;
    miniDragRef.current = null;
    if (g && g.mode === 'move' && !g.moved) {
      lastMiniTapTimeRef.current = Date.now();
      if (onToggleMiniPlayer) onToggleMiniPlayer(false);
    }
  };

  const handleMiniMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isMiniPlayer || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };

    const onMouseMove = (ev: MouseEvent) => {
      const g = miniDragRef.current;
      if (!g) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (g.mode === 'resize') {
        const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
        const nextW = clampMiniWidthVal(g.origWidth + deltaW);
        setMiniWidth(nextW);
        setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
        return;
      }
      if (!g.moved && Math.hypot(dx, dy) > 6) {
        g.moved = true;
      }
      if (g.moved) {
        setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const g = miniDragRef.current;
      miniDragRef.current = null;
      if (g && g.mode === 'move' && !g.moved) {
        lastMiniTapTimeRef.current = Date.now();
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (isMiniPlayer) {
      if (Date.now() - lastMiniTapTimeRef.current > 350) {
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
      return;
    }
    if (isScreenLocked) {
      resetOverlayAutoHide();
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const ratio = isRotated90
      ? (e.clientY - rect.top) / Math.max(1, rect.height)
      : (e.clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'right' | 'center' =
      ratio < 0.34 ? 'left' : ratio > 0.66 ? 'right' : 'center';

    const now = Date.now();
    if (now - lastTapRef.current.time < 290 && lastTapRef.current.side === side && side !== 'center') {
      handleSeekRelative(side === 'left' ? -10 : 10);
      lastTapRef.current = { time: 0, side: 'center' };
      return;
    }

    lastTapRef.current = { time: now, side };
    if (showOverlayControls) {
      setShowOverlayControls(false);
      setShowBrightnessPanel(false);
      setShowQualityMenu(false);
      setShowAudioServerMenu(false);
      setShowSleepMenu(false);
    } else {
      resetOverlayAutoHide();
    }
  };

  const handleSubtitleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoadingAutoSub(true);
      const text = await file.text();
      const parsedCues = parseSrtOrVttToCues(text);
      if (parsedCues.length > 0) {
        // Automatically translate uploaded English/foreign subtitles to Bengali if not already Bengali
        const sampleText = parsedCues
          .slice(0, 5)
          .map((c) => c.text)
          .join(' ');
        const hasBanglaChars = /[\u0980-\u09FF]/.test(sampleText);
        if (!hasBanglaChars) {
          triggerHud('toast', 'ইংরেজি সাবটাইটেল বাংলায় অনুবাদ করা হচ্ছে...');
          const firstBatch = parsedCues.slice(0, 60);
          for (let i = 0; i < firstBatch.length; i += 30) {
            const chunk = firstBatch.slice(i, i + 30);
            const tr = await translateLinesToBangla(chunk.map((c) => c.text));
            chunk.forEach((c, idx) => {
              if (tr[idx]) c.text = tr[idx];
            });
          }
          // Translate rest in background
          if (parsedCues.length > 60) {
            (async () => {
              for (let i = 60; i < Math.min(parsedCues.length, 500); i += 35) {
                const chunk = parsedCues.slice(i, i + 35);
                const tr = await translateLinesToBangla(chunk.map((c) => c.text));
                chunk.forEach((c, idx) => {
                  if (tr[idx]) c.text = tr[idx];
                });
              }
            })().catch(() => {});
          }
        }
        const vttBuilt = buildVttFromCues(parsedCues);
        const blob = new Blob([vttBuilt], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleCues(parsedCues);
        setSubtitleUrl(url);
        setSubtitleName(`বাংলা Sub (${file.name})`);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `বাংলা সাবটাইটেল লোড হয়েছে: ${file.name}`);
      } else {
        const vttText = convertSrtToVtt(text);
        const blob = new Blob([vttText], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleUrl(url);
        setSubtitleName(file.name);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `Subtitle Loaded: ${file.name}`);
      }
    } catch {
      // ignore
    } finally {
      setLoadingAutoSub(false);
    }
  };

  const handleShare = async () => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareParams = new URLSearchParams({
      watch: movie.path || movie.url,
      title: detail?.title || movie.title,
    });
    const shareUrl = `${baseUrl}?${shareParams.toString()}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: detail?.title || movie.title,
          text: `Watch ${detail?.title || movie.title} in Full HD on CinePulse`,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedShare(true);
        setTimeout(() => setCopiedShare(false), 2000);
      }
    } catch {
      // ignore
    }
  };

  const handleCopyAllEpisodes = async () => {
    const lines = episodes
      .map((ep) => {
        const bestSrc = ep.sources?.[0];
        if (!bestSrc) return null;
        return `${ep.label}: ${toGatewayAbsoluteUrl(bestSrc.downloadUrl || bestSrc.url)}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!lines) return;
    try {
      await navigator.clipboard.writeText(lines);
      setCopiedBatch(true);
      setTimeout(() => setCopiedBatch(false), 2200);
    } catch {
      // ignore
    }
  };

  const handleDownloadM3UPlaylist = () => {
    const lines = ['#EXTM3U'];
    episodes.forEach((ep) => {
      const bestSrc = ep.sources?.[0];
      if (bestSrc?.url) {
        lines.push(`#EXTINF:-1,${detail?.title || movie.title} - ${ep.label}`);
        lines.push(bestSrc.url);
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(detail?.title || movie.title).replace(/[^a-zA-Z0-9_-]/g, '_')}_Playlist.m3u`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const vlcUrl = activeSource?.url
    ? `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const infuseUrl = activeSource?.url
    ? `infuse://x-callback-url/play?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const outplayerUrl = activeSource?.url ? `outplayer://${activeSource.url}` : '';

  const ratingScore = detail?.communityScore
    ? (detail.communityScore.recommendedPercent / 10).toFixed(1)
    : '8.7';

  const ctrlTotalDur = iosControllerRef.current?.getTotalDurationSec() || 0;
  const displayDuration = Math.floor(duration > 0 ? duration : ctrlTotalDur > 0 ? ctrlTotalDur : 0);
  const effectiveDuration = Math.max(1, displayDuration || 1);
  const activePlayheadSec = isScrubbing && scrubPreview !== null ? scrubPreview.sec : currentTime;
  const progressPercent =
    displayDuration > 0 ? Math.min(100, (activePlayheadSec / effectiveDuration) * 100) : 0;
  const bufferedPercent =
    displayDuration > 0 ? Math.min(100, (bufferedEnd / effectiveDuration) * 100) : 0;

  // CSS video brightness boost filter (supports darkening down to 20% AND brightening dark movie scenes up to 160%)
  const videoFilterStyle: React.CSSProperties = {
    filter: `brightness(${brightness}%) contrast(${brightness > 110 ? 105 : 100}%) saturate(${
      brightness > 115 ? 108 : 100
    }%)`,
    objectFit: videoFit,
  };

  // Show up to 60 tiles in the horizontal bar for instant 60fps scrolling, and all in the "All" grid
  const horizontalEpisodesSlice = filteredEpisodesWithIdx.slice(0, 60);

  const isRotated90 = !isMiniPlayer && (isLandscapeMode || isFullscreen) && isViewportPortrait;

  const computeScrubberTarget = (
    clientX: number,
    clientY: number,
    el?: HTMLDivElement | null
  ) => {
    const targetEl = el || scrubberRef.current;
    if (!targetEl) {
      return { targetSec: currentTime, percent: progressPercent };
    }
    const rect = targetEl.getBoundingClientRect();
    const ratio = isRotated90
      ? (clientY - rect.top) / Math.max(1, rect.height)
      : (clientX - rect.left) / Math.max(1, rect.width);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const targetSec = Math.floor(clampedRatio * effectiveDuration);
    return { targetSec, percent: clampedRatio * 100 };
  };

  const previewScrubberAtPointer = (
    clientX: number,
    clientY: number,
    el?: HTMLDivElement | null
  ) => {
    const { targetSec, percent } = computeScrubberTarget(clientX, clientY, el);
    scrubTargetSecRef.current = targetSec;
    lastRecordedSecondRef.current = targetSec;
    setScrubPreview({ sec: targetSec, percent });
    setCurrentTime(targetSec);
    return targetSec;
  };

  const commitScrubberSeek = (targetSec: number) => {
    scrubTargetSecRef.current = targetSec;
    lastRecordedSecondRef.current = targetSec;
    setCurrentTime(targetSec);
    seekVideoToGlobalTime(targetSec);
  };

  const hasNextEpisode = episodes.length > 1 && selectedEpIdx + 1 < episodes.length;
  const nextEpisodeItem = hasNextEpisode ? episodes[selectedEpIdx + 1] : undefined;

  const combinedScreenshots = (() => {
    const list: string[] = [];
    const add = (u?: string) => {
      if (u && u.startsWith('http') && !list.includes(u)) list.push(u);
    };
    (myflixData?.screenshots || []).forEach(add);
    (effectiveDetail?.screenshots || []).forEach(add);
    if (list.length === 0) {
      add(effectiveDetail?.backdrop);
      add(movie.poster || effectiveDetail?.poster);
    }
    return list;
  })();

  const combinedCast = (() => {
    const list: Array<{ name: string; role: string; photo: string }> = [];
    const seen = new Set<string>();
    const add = (c: { name?: string; role?: string; photo?: string }) => {
      const n = (c.name || '').trim();
      if (!n || seen.has(n.toLowerCase())) return;
      seen.add(n.toLowerCase());
      list.push({
        name: n,
        role: c.role || 'Actor',
        photo: c.photo || '',
      });
    };
    (myflixData?.cast || []).forEach(add);
    (effectiveDetail?.cast || []).forEach(add);
    return list;
  })();

  const combinedDownloads = (() => {
    const list: Array<{ label: string; subLabel?: string; url: string }> = [];
    const seen = new Set<string>();
    for (const src of activeEpisode?.sources || []) {
      const dlUrl = src.downloadUrl || src.url;
      if (dlUrl && src.type !== 'embed' && !seen.has(dlUrl)) {
        seen.add(dlUrl);
        list.push({
          label: `Download ${src.quality || 720}p`,
          subLabel: `${src.audioLanguages?.join(' + ') || src.audio || movie.language} • ${
            src.quality >= 1080 ? 'Full HD' : 'High Speed'
          }`,
          url: dlUrl,
        });
      }
    }
    for (const btn of effectiveDetail?.downloadButtons || []) {
      if (btn.url && !seen.has(btn.url)) {
        seen.add(btn.url);
        list.push({
          label: btn.label.replace(/^download\s*/i, 'Download '),
          subLabel: btn.quality ? `${btn.quality} • Direct Link` : 'Direct High-Speed Server',
          url: btn.url,
        });
      }
    }
    for (const mDl of myflixData?.downloads || []) {
      if (mDl.url && !seen.has(mDl.url)) {
        seen.add(mDl.url);
        list.push({
          label: mDl.label,
          subLabel: 'Cloud Mirror Download',
          url: mDl.url,
        });
      }
    }
    return list;
  })();

  const displayYear =
    myflixData?.year ||
    effectiveDetail?.releaseDate?.match(/\b(20\d{2}|19\d{2})\b/)?.[1] ||
    (movie.title.match(/\b(20\d{2}|19\d{2})\b/)?.[1] ?? '2026');
  const displayGenre =
    myflixData?.genre ||
    effectiveDetail?.genre ||
    (movie.typeBadge === 'SERIES' ? 'Drama, Crime, Series' : 'Action, Drama, Thriller');
  const displayDirector = myflixData?.director || 'CinePulse Original';
  const displayRelease =
    myflixData?.release || effectiveDetail?.releaseDate || normalizeMovieCardItem(movie).timeAgo;
  const displayRating =
    myflixData?.rating || normalizeMovieCardItem(movie).rating || ratingScore || '8.7';
  const currentEpBadgeText = activeEpisode
    ? formatEpisodeTileBadge(activeEpisode, selectedEpIdx)
    : '1';
  const activeSeasonLabel =
    selectedSeasonFilter === 'all'
      ? distinctSeasons.length > 0
        ? `Season ${String(distinctSeasons[0]).padStart(2, '0')}`
        : 'Season 01'
      : `Season ${String(selectedSeasonFilter).padStart(2, '0')}`;

  return (
    <div
      ref={modalContainerRef}
      onTouchStart={isMiniPlayer ? handleMiniTouchStart : undefined}
      onTouchMove={isMiniPlayer ? handleMiniTouchMove : undefined}
      onTouchEnd={isMiniPlayer ? handleMiniTouchEnd : undefined}
      onMouseDown={isMiniPlayer ? handleMiniMouseDown : undefined}
      style={
        isMiniPlayer
          ? {
              width: `${miniWidth}px`,
              ...(miniPos
                ? { left: `${miniPos.x}px`, top: `${miniPos.y}px` }
                : { right: '12px', bottom: '76px' }),
              touchAction: 'none',
            }
          : undefined
      }
      className={
        isMiniPlayer
          ? 'fixed z-50 rounded-2xl overflow-hidden shadow-[0_18px_48px_rgba(0,0,0,0.92)] border border-[#dc2626]/60 bg-[#050505] text-[#e5e5e5] flex flex-col cursor-grab active:cursor-grabbing select-none'
          : `fixed inset-0 z-50 w-full max-w-[100vw] bg-[#050505] text-[#e5e5e5] flex flex-col ${
              isLandscapeMode || isFullscreen
                ? 'overflow-hidden'
                : 'overflow-y-auto overflow-x-hidden overscroll-y-contain'
            }`
      }
    >
      {/* Top Clean MyFlixBD-Style Navbar (Hidden in Mini Player or Fullscreen) */}
      {!isMiniPlayer && !isLandscapeMode && !isFullscreen && (
        <header className="sticky top-0 z-40 w-full bg-[#0a0a0a]/95 backdrop-blur-md border-b border-white/[0.08]">
          <div className="max-w-5xl mx-auto px-3 sm:px-6 h-13 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={onClose}
                aria-label="Back to Home"
                className="w-9 h-9 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/[0.08] flex items-center justify-center text-white active:scale-95 transition-all shrink-0"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-2 text-left group truncate"
              >
                <span className="w-7 h-7 rounded-md bg-[#dc2626] flex items-center justify-center text-white shadow-[0_0_12px_rgba(220,38,38,0.5)] shrink-0">
                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                </span>
                <span className="text-base font-black tracking-wider text-white">
                  CINE<span className="text-[#dc2626]">PULSE</span>
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onToggleWatchlist(movie, currentFolder)}
                className={`h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                  isInWatchlist
                    ? 'bg-[#dc2626]/20 border-[#dc2626] text-white'
                    : 'bg-[#151515] hover:bg-[#222222] border-white/[0.08] text-gray-200'
                }`}
              >
                <ListPlus className="w-3.5 h-3.5 text-[#dc2626]" />
                <span className="hidden xs:inline">{isInWatchlist ? 'Saved' : 'Watchlist'}</span>
              </button>

              <button
                type="button"
                onClick={handleShare}
                className="h-8 px-3 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/[0.08] text-xs font-semibold text-gray-200 flex items-center gap-1.5 transition-colors"
              >
                {copiedShare ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-3.5 h-3.5 text-[#dc2626]" />
                    <span className="hidden xs:inline">Share</span>
                  </>
                )}
              </button>

              {onToggleMiniPlayer && (
                <button
                  type="button"
                  onClick={() => onToggleMiniPlayer(true)}
                  title="Mini Player"
                  className="w-8 h-8 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/[0.08] text-gray-200 flex items-center justify-center transition-colors"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </header>
      )}

      {/* Main MyFlixBD Container (Sections 1, 2, 3, 4, 5) */}
      <div
        className={
          isMiniPlayer
            ? 'w-full'
            : isLandscapeMode || isFullscreen
              ? 'w-full h-full'
              : 'w-full max-w-5xl mx-auto px-2.5 sm:px-6 pt-3 pb-28 flex flex-col gap-5'
        }
      >
        {/* =====================================================================
            SECTION 1: CLEAN 16:9 VIDEO CONTAINER (NO LONG-PRESS CONTEXT MENU, NO EMBEDDED TEXT)
           ===================================================================== */}
        <section className="w-full">
          <div className="bg-[#0a0a0a] border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
            {/* #player-container-0 — Zero-Overhead 16:9 Hardware Video Container + Left Sound / Right Brightness Finger Swipe */}
            <div
              ref={playerStageRef}
              id="player-container-0"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onTouchStart={handleStageTouchStart}
              onTouchMove={handleStageTouchMove}
              onTouchEnd={handleStageTouchEnd}
              onClick={handleStageClick}
              style={{
                WebkitTouchCallout: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none',
              }}
              className={
                isMiniPlayer
                  ? 'relative w-full aspect-video bg-black select-none'
                  : isLandscapeMode || isFullscreen
                    ? 'fixed inset-0 z-[9999] w-screen h-screen bg-black flex items-center justify-center select-none touch-none'
                    : 'relative w-full aspect-video bg-black overflow-hidden select-none touch-none'
              }
            >
              {/* Mini-Player Quick Controls */}
              {isMiniPlayer && (
                <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between">
                  <div className="flex items-center justify-between p-1.5">
                    <button
                      type="button"
                      data-mini-cycle="true"
                      onClick={handleCycleMiniSize}
                      className="pointer-events-auto w-6 h-6 rounded-full bg-black/75 text-white flex items-center justify-center border border-white/20"
                    >
                      {miniWidth >= 295 ? (
                        <Minimize2 className="w-3 h-3" />
                      ) : (
                        <Maximize2 className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      data-mini-close="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                      }}
                      className="pointer-events-auto w-6 h-6 rounded-full bg-black/75 text-white hover:text-red-400 flex items-center justify-center border border-white/20"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Exit Fullscreen Button when in custom Landscape / Fullscreen */}
              {!isMiniPlayer && (isLandscapeMode || isFullscreen) && (
                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className="absolute top-3 left-3 z-40 px-3 py-1.5 rounded-lg bg-black/75 border border-white/20 text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Exit Fullscreen</span>
                </button>
              )}

              {/* Hold 2x Speed Indicator */}
              {!isMiniPlayer && isHold2x && (
                <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-40 px-3.5 py-1 rounded-full bg-[#dc2626] text-white text-xs font-extrabold flex items-center gap-1.5 shadow-lg">
                  <FastForward className="w-3.5 h-3.5 fill-current" />
                  <span>2x Fast Speed</span>
                </div>
              )}

              {/* Double-Tap +-10s Ripple Indicator */}
              {!isMiniPlayer && seekRipple && (
                <div
                  className={`pointer-events-none absolute inset-y-0 ${
                    seekRipple.side === 'left' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'
                  } w-1/3 bg-[#dc2626]/25 backdrop-blur-[2px] z-30 flex flex-col items-center justify-center text-white animate-pulse`}
                >
                  {seekRipple.side === 'left' ? (
                    <RotateCcw className="w-7 h-7 text-white mb-1" />
                  ) : (
                    <RotateCw className="w-7 h-7 text-white mb-1" />
                  )}
                  <span className="text-xs font-extrabold">
                    {seekRipple.delta > 0 ? `+${seekRipple.delta}s` : `${seekRipple.delta}s`}
                  </span>
                </div>
              )}

              {playerMode === 'trailer' && effectiveDetail?.youtubeTrailerId ? (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${effectiveDetail.youtubeTrailerId}?autoplay=1&rel=0&playsinline=1`}
                  title={effectiveDetail.title}
                  sandbox="allow-scripts allow-same-origin allow-presentation"
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              ) : isEmbedSource && activeSource?.url ? (
                <iframe
                  key={activeSource.url}
                  src={activeSource.url}
                  title={effectiveDetail?.title || movie.title}
                  sandbox="allow-scripts allow-same-origin allow-presentation"
                  referrerPolicy="no-referrer"
                  style={{ filter: `brightness(${brightness}%)` }}
                  className="w-full h-full border-0 bg-black"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              ) : effectiveVideoUrl && !videoError ? (
                <>
                  <video
                    ref={videoRef}
                    src={effectiveVideoUrl}
                    poster={movie.poster || effectiveDetail?.poster}
                    style={{
                      ...videoFilterStyle,
                      WebkitTouchCallout: 'none',
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                    }}
                    muted={isMuted || currentTime < Math.max(13.5, introSkipSec)}
                    controls={!isMiniPlayer}
                    playsInline
                    autoPlay
                    preload="auto"
                    disablePictureInPicture
                    controlsList="nodownload nofullscreen noremoteplayback"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPlay={(e) => {
                      const v = e.currentTarget;
                      setIsPlaying(true);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                    }}
                    onPlaying={(e) => {
                      const v = e.currentTarget;
                      setIsPlaying(true);
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                    }}
                    onLoadedData={(e) => {
                      const v = e.currentTarget;
                      isSeekingRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                      if (useHlsBridge && v.paused && v.currentTime < 0.5) {
                        startVideoWithiOSFallback(v);
                      }
                    }}
                    onCanPlay={(e) => {
                      const v = e.currentTarget;
                      isSeekingRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                      if (v.paused && v.currentTime < 0.5) {
                        startVideoWithiOSFallback(v);
                      }
                    }}
                    onWaiting={() => {
                      smoothPlaySecondsRef.current = 0;
                      setIsBuffering(true);
                    }}
                    onSeeked={(e) => {
                      const v = e.currentTarget;
                      isSeekingRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                    }}
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onTimeUpdate={(e) => {
                      if (
                        isScrubbing ||
                        isScrubbingRef.current ||
                        isSeekingRef.current ||
                        iosTransitioningRef.current
                      ) {
                        return;
                      }
                      const v = e.currentTarget;
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          if (v.textTracks[i].mode !== 'disabled') {
                            v.textTracks[i].mode = 'disabled';
                          }
                        }
                      } catch {
                        // ignore
                      }
                      if (v.readyState >= 2) {
                        if (!hasStartedPlayback) setHasStartedPlayback(true);
                        if (isBuffering) setIsBuffering(false);
                      }
                      const segDur = v.duration || 0;
                      if (
                        useHlsBridge &&
                        iosControllerRef.current &&
                        segDur > 0 &&
                        segDur - v.currentTime < 6.5
                      ) {
                        iosControllerRef.current.ensureNextSegmentPrebuffered(
                          iosCurrentSegIndexRef.current + 1
                        );
                      }
                      const globalSec = Math.floor(
                        useHlsBridge
                          ? iosSegmentStartSecRef.current + v.currentTime
                          : v.currentTime
                      );
                      const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
                      const dur = Math.floor(totalFromCtrl > 0 ? totalFromCtrl : segDur);
                      if (globalSec !== lastRecordedSecondRef.current) {
                        lastRecordedSecondRef.current = globalSec;
                        setCurrentTime(globalSec);
                        if (dur > 0 && dur !== duration) setDuration(dur);
                        if (globalSec > 5 && globalSec % 10 === 0) {
                          onRecordWatchProgress(
                            movie,
                            activeEpisode,
                            selectedEpIdx,
                            activeSource,
                            globalSec,
                            dur
                          );
                        }
                      }
                    }}
                    onEnded={() => {
                      if (useHlsBridge && iosControllerRef.current) {
                        advanceToNextIosSegment().then((advanced) => {
                          if (!advanced) {
                            setIsPlaying(false);
                            if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                              handleSelectEpisode(selectedEpIdx + 1);
                            }
                          }
                        });
                        return;
                      }
                      setIsPlaying(false);
                      if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                        handleSelectEpisode(selectedEpIdx + 1);
                      }
                    }}
                    onError={handleVideoError}
                    className="w-full h-full bg-black object-contain select-none"
                  />

                  {/* iOS 1-Tap Unmute Pill if Safari blocked unmuted autoplay after 13.5s */}
                  {autoMutedForiOS && isMuted && currentTime >= 13.5 && !isMiniPlayer && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsMuted(false);
                        setAutoMutedForiOS(false);
                        if (videoRef.current) {
                          videoRef.current.muted = false;
                          videoRef.current.play().catch(() => {});
                        }
                      }}
                      className="absolute top-3 right-3 z-30 px-3 py-1.5 rounded-lg bg-[#dc2626] text-white text-xs font-bold flex items-center gap-1.5 shadow-xl"
                    >
                      <Volume2 className="w-4 h-4" />
                      <span>Tap for Sound</span>
                    </button>
                  )}
                </>
              ) : loading ||
                (useHlsBridge &&
                  !isEmbedSource &&
                  activeSource?.url &&
                  !effectiveVideoUrl &&
                  !videoError) ? (
                <div className="relative w-full h-full flex items-center justify-center bg-black">
                  {(movie.poster || effectiveDetail?.poster) && (
                    <img
                      src={movie.poster || effectiveDetail?.poster}
                      alt={movie.title}
                      className="absolute inset-0 w-full h-full object-cover opacity-35 blur-xs pointer-events-none"
                    />
                  )}
                  <div className="relative z-10 flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 animate-spin text-[#dc2626]" />
                    <span className="text-xs font-medium text-gray-300">Loading Stream...</span>
                  </div>
                </div>
              ) : (
                <div className="relative w-full h-full flex flex-col items-center justify-center p-5 text-center bg-[#0a0a0a]">
                  <p className="text-xs sm:text-sm text-gray-300 mb-3">
                    যদি Server 1 প্লে না হয়, নিচের অন্য Server সিলেক্ট করুন অথবা সরাসরি ডাউনলোড করুন।
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {sources.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectSource((selectedSourceIdx + 1) % sources.length, true)
                        }
                        className="px-4 py-2 rounded-lg bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-bold flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Try Next Server</span>
                      </button>
                    )}
                    {activeSource?.url && (
                      <a
                        href={vlcUrl}
                        className="px-4 py-2 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/10 text-white text-xs font-bold flex items-center gap-1.5"
                      >
                        <Tv className="w-3.5 h-3.5 text-[#dc2626]" />
                        <span>Play in VLC</span>
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Single Small Bangla Subtitle at the Bottom of the Video Screen (Only when manually turned ON) */}
              {!isMiniPlayer && autoBanglaSubEnabled && activeBanglaCueText && (
                <div className="pointer-events-none select-none absolute inset-x-2 bottom-2 sm:bottom-3 z-30 flex justify-center">
                  <div
                    className="max-w-[90%] px-2 py-0.5 rounded bg-black/55 text-center font-medium text-white text-[11px] sm:text-xs leading-tight tracking-wide"
                    style={{
                      fontFamily: "'Hind Siliguri', sans-serif",
                      textShadow:
                        '0 1px 2px rgba(0,0,0,0.98), 0 0 4px rgba(0,0,0,0.95), -1px -1px 0 #000, 1px -1px 0 #000',
                    }}
                  >
                    {activeBanglaCueText}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* =====================================================================
            LOWER UI SECTION — EXACT MATCH TO USER SCREENSHOT 1
           ===================================================================== */}
        {!isMiniPlayer && !isLandscapeMode && !isFullscreen && (
          <div className="px-1 sm:px-2 space-y-5">
            {/* 1. Title + "Info >" + Single-Line Metadata + Horizontal Action Pills */}
            <section className="space-y-2.5">
              {/* Title + Inline "Info >" */}
              <div className="flex items-baseline flex-wrap gap-x-2.5 gap-y-1">
                <h1 className="text-lg sm:text-2xl font-extrabold text-white leading-tight">
                  {effectiveDetail?.title || movie.title}
                </h1>
                <button
                  type="button"
                  onClick={() =>
                    setBottomTab(bottomTab === 'infoCast' ? 'forYou' : 'infoCast')
                  }
                  className="inline-flex items-center gap-0.5 text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  <span>Info</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Compact Single-Line Metadata: 📺 | ⭐ 8.0 | 2026 | Language | Genre | 1 seasons */}
              <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-gray-400">
                <Tv className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="text-gray-600">|</span>
                <span className="inline-flex items-center gap-1 text-amber-400 font-bold">
                  <Star className="w-3.5 h-3.5 fill-current" />
                  <span>{displayRating}</span>
                </span>
                <span className="text-gray-600">|</span>
                <span>{displayYear}</span>
                <span className="text-gray-600">|</span>
                <span>{effectiveDetail?.language || movie.language}</span>
                <span className="text-gray-600">|</span>
                <span>{(displayGenre.split(',')[0] || 'Drama').trim()}</span>
                <span className="text-gray-600">|</span>
                <span>{distinctSeasons.length || 1} seasons</span>
              </div>

              {/* Horizontal Action Pills: [ Add to list ] [ Share ] [ Download ] [ Video / Sub ] */}
              <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar pt-1">
                <button
                  type="button"
                  onClick={() => onToggleWatchlist(movie, currentFolder)}
                  className={`h-10 px-4 rounded-full text-xs sm:text-sm font-medium flex items-center gap-2 shrink-0 transition-colors cursor-pointer ${
                    isInWatchlist
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <ListPlus className="w-4 h-4" />
                  <span>{isInWatchlist ? 'Added to list' : 'Add to list'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleShare}
                  className="h-10 px-4 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-2 shrink-0 transition-colors cursor-pointer"
                >
                  {copiedShare ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Share2 className="w-4 h-4" />
                      <span>Share</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setShowDownloadSheet(true)}
                  className="h-10 px-4 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-2 shrink-0 transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download</span>
                </button>

                <input
                  ref={subtitleInputRef}
                  type="file"
                  accept=".srt,.vtt"
                  onChange={handleSubtitleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => setAutoBanglaSubEnabled((v) => !v)}
                  className={`h-10 px-4 rounded-full text-xs sm:text-sm font-medium flex items-center gap-2 shrink-0 transition-colors cursor-pointer ${
                    autoBanglaSubEnabled
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <ListVideo className="w-4 h-4" />
                  <span>{autoBanglaSubEnabled ? 'Bangla Sub: ON' : 'Video / Sub'}</span>
                </button>
              </div>
            </section>

            {/* 2. Resources Section: Header + Audio/Server Dropdown + [ All ] [ 01 ] [ 02 ] [ 03 ] Episode Tiles */}
            <section className="space-y-3">
              {/* Resources Header */}
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-extrabold text-white">Resources</h2>
                <span className="text-xs sm:text-sm text-gray-400">
                  Uploaded by CinePulse Cloud etc.
                </span>
                <HelpCircle className="w-4 h-4 text-gray-400 shrink-0" />
              </div>

              {/* Audio / Server / Season Dropdown Box ([ Hindi dub ⌄ ]) */}
              <div className="relative inline-block">
                <button
                  type="button"
                  onClick={() => setShowSeasonDropdown((v) => !v)}
                  className="h-10 px-3.5 rounded-lg bg-[#121418] hover:bg-[#1b1d21] border border-white/15 text-xs sm:text-sm font-medium text-gray-100 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <span>
                    {effectiveDetail?.language || movie.language}
                    {sources.length > 1
                      ? ` · Server ${selectedSourceIdx + 1} (${activeSource?.quality || 720}p)`
                      : distinctSeasons.length > 1
                        ? ` · ${activeSeasonLabel}`
                        : ' dub'}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-gray-400 transition-transform ${
                      showSeasonDropdown ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {showSeasonDropdown && (
                  <div className="absolute left-0 top-full mt-1.5 min-w-[230px] max-h-72 overflow-y-auto bg-[#121418] border border-white/15 rounded-xl shadow-2xl z-30 py-1.5 divide-y divide-white/10">
                    {/* Server / Resolution Options */}
                    {sources.length > 0 && (
                      <div className="py-1">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          Stream Servers
                        </div>
                        {sources.map((src, idx) => {
                          const isActive = selectedSourceIdx === idx;
                          return (
                            <button
                              key={src.id || idx}
                              type="button"
                              onClick={() => {
                                handleSelectSource(idx, true);
                                setShowSeasonDropdown(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-xs font-semibold flex items-center justify-between transition-colors ${
                                isActive
                                  ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                  : 'text-gray-200 hover:bg-white/5'
                              }`}
                            >
                              <span>
                                Server {idx + 1} · {src.audio || movie.language} ({src.quality || 720}p)
                              </span>
                              {isActive && <Check className="w-3.5 h-3.5 text-[#ef4444]" />}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Season Options if Multi-Season */}
                    {distinctSeasons.length > 1 && (
                      <div className="py-1">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          Seasons
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSeasonFilter('all');
                            setShowSeasonDropdown(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                            selectedSeasonFilter === 'all'
                              ? 'bg-[#dc2626]/20 text-[#ef4444]'
                              : 'text-gray-200 hover:bg-white/5'
                          }`}
                        >
                          All Seasons ({episodes.length})
                        </button>
                        {distinctSeasons.map((sNum) => (
                          <button
                            key={sNum}
                            type="button"
                            onClick={() => {
                              setSelectedSeasonFilter(sNum);
                              setShowSeasonDropdown(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                              selectedSeasonFilter === sNum
                                ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                : 'text-gray-200 hover:bg-white/5'
                            }`}
                          >
                            Season {String(sNum).padStart(2, '0')}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Related Season Packs */}
                    {(effectiveDetail?.relatedSeasons || []).length > 0 && (
                      <div className="py-1">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          More Seasons
                        </div>
                        {(effectiveDetail?.relatedSeasons || []).map((relSeason) => {
                          const normS = normalizeMovieCardItem(relSeason);
                          return (
                            <button
                              key={relSeason.path}
                              type="button"
                              onClick={() => {
                                setShowSeasonDropdown(false);
                                onSelectMovie(normS);
                              }}
                              className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/5 truncate"
                            >
                              {normS.episodePill || normS.title}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Horizontal Episode Tiles Row: [ All ] [ 01 ] [ 02 ] [ 03 ] [ 04 ] [ 05 ] [ 06 ] ... */}
              <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar py-0.5">
                {/* "All" Tile First on the Left (Exact Match to Screenshot 1) */}
                <button
                  type="button"
                  onClick={() => setShowAllEpisodesModal(true)}
                  className="w-[54px] h-[48px] rounded-xl bg-[#1b1d21] hover:bg-[#25282e] text-white text-sm font-medium flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                >
                  All
                </button>

                {(horizontalEpisodesSlice.length > 0
                  ? horizontalEpisodesSlice
                  : [
                      {
                        ep: {
                          id: 'ep-1',
                          label: '01',
                          number: 1,
                          season: 1,
                          kind: 'movie' as const,
                          sources: [],
                        },
                        idx: 0,
                      },
                    ]
                ).map(({ ep, idx }) => {
                  const isSelected = idx === selectedEpIdx;
                  const rawBadge = formatEpisodeTileBadge(ep, idx);
                  const badgeStr = rawBadge === 'Movie' ? '01' : rawBadge;
                  return (
                    <button
                      key={ep.id || idx}
                      type="button"
                      onClick={() => handleSelectEpisode(idx)}
                      className={`min-w-[54px] h-[48px] px-3 rounded-xl text-sm font-semibold flex items-center justify-center shrink-0 transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-gradient-to-br from-[#dc2626]/30 to-[#7f1d1d]/35 border border-[#dc2626]/60 text-[#ef4444] font-bold shadow-[0_0_12px_rgba(220,38,38,0.2)]'
                          : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                      }`}
                    >
                      {badgeStr}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 3. Bottom Navigation Tabs: "For you" and "Comments(36)•" */}
            <section className="pt-1 space-y-4">
              <div className="flex items-center gap-7 border-b border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setBottomTab('forYou')}
                  className="relative pb-2.5 text-base sm:text-lg font-extrabold transition-colors cursor-pointer"
                >
                  <span className={bottomTab === 'forYou' ? 'text-white' : 'text-gray-400'}>
                    For you
                  </span>
                  {bottomTab === 'forYou' && (
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setBottomTab('reviews')}
                  className="relative pb-2.5 text-base sm:text-lg font-medium flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <span
                    className={
                      bottomTab === 'reviews' ? 'text-white font-extrabold' : 'text-gray-400'
                    }
                  >
                    Comments({36 + (customReviewsMap[movie.path]?.length || 0)})
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] -mt-2" />
                  {bottomTab === 'reviews' && (
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  )}
                </button>

                {bottomTab === 'infoCast' && (
                  <button
                    type="button"
                    onClick={() => setBottomTab('infoCast')}
                    className="relative pb-2.5 text-base sm:text-lg font-extrabold text-white cursor-pointer"
                  >
                    <span>Info & Cast</span>
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  </button>
                )}
              </div>

              {/* TAB 1: "For you" — 3-Column Poster Grid with Top-Right Language Badge & Bottom 1-Line Title */}
              {bottomTab === 'forYou' && (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
                  {relatedMovies.slice(0, 12).map((rawRel) => {
                    const rel = normalizeMovieCardItem(rawRel);
                    const shortLang = /bangla|bengali/i.test(rel.language)
                      ? 'Bangla'
                      : /hindi/i.test(rel.language)
                        ? 'Hindi'
                        : /korean/i.test(rel.language)
                          ? 'Korean'
                          : /tamil|telugu/i.test(rel.language)
                            ? 'South'
                            : 'Hindi';
                    return (
                      <button
                        key={rel.path + rel.title}
                        type="button"
                        onMouseEnter={() =>
                          prefetchMovieDetails(rel.path, rel.title, activeNodeId, true)
                        }
                        onTouchStart={() =>
                          prefetchMovieDetails(rel.path, rel.title, activeNodeId, true)
                        }
                        onClick={() => {
                          if (modalContainerRef.current) {
                            modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                          }
                          onSelectMovie(rel);
                        }}
                        className="group rounded-xl overflow-hidden bg-[#16181c] flex flex-col text-left transition-transform active:scale-95 cursor-pointer"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#101216] overflow-hidden">
                          {rel.poster && (
                            <img
                              src={rel.poster}
                              alt={rel.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          )}
                          <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded bg-black/60 backdrop-blur-[2px] text-[10px] sm:text-[11px] font-medium text-white">
                            {shortLang}
                          </span>
                        </div>
                        <div className="px-2.5 py-2 bg-[#16181c]">
                          <div className="text-xs sm:text-sm font-medium text-gray-100 truncate">
                            {rel.title}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* TAB 2: "Comments(36)" — Audience Comments & Rating */}
              {bottomTab === 'reviews' && (
                <div className="space-y-4">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const trimmed = userReviewText.trim();
                      if (!trimmed) return;
                      const entry = {
                        id: String(Date.now()),
                        author: userReviewName.trim() || 'CinePulse Viewer',
                        stars: userRatingStars,
                        text: trimmed,
                        date: 'Just now',
                      };
                      const nextMap = {
                        ...customReviewsMap,
                        [movie.path]: [entry, ...(customReviewsMap[movie.path] || [])],
                      };
                      setCustomReviewsMap(nextMap);
                      setUserReviewText('');
                      try {
                        localStorage.setItem('cp_moviebox_reviews_v1', JSON.stringify(nextMap));
                      } catch {
                        // ignore
                      }
                    }}
                    className="bg-[#121418] border border-white/10 rounded-xl p-3.5 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-200">Leave a Comment</span>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((st) => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => setUserRatingStars(st)}
                            className="p-0.5"
                          >
                            <Star
                              className={`w-4 h-4 ${
                                st <= userRatingStars
                                  ? 'text-amber-400 fill-current'
                                  : 'text-gray-600'
                              }`}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={userReviewText}
                        onChange={(e) => setUserReviewText(e.target.value)}
                        placeholder="Write your comment..."
                        className="flex-1 h-9 px-3 rounded-lg bg-[#1b1d21] border border-white/10 text-xs text-white focus:outline-none focus:border-[#dc2626]"
                      />
                      <button
                        type="submit"
                        className="h-9 px-4 rounded-lg bg-[#dc2626] text-white text-xs font-bold shrink-0"
                      >
                        Post
                      </button>
                    </div>
                  </form>

                  <div className="space-y-2.5">
                    {[
                      ...(customReviewsMap[movie.path] || []),
                      {
                        id: 'c1',
                        author: 'Tanvir Ahmed',
                        stars: 5,
                        text: 'অসাধারণ প্রিন্ট আর একদম বাফারিং ছাড়া স্মুথ চলছে! ১০/১০।',
                        date: '2h ago',
                      },
                      {
                        id: 'c2',
                        author: 'Sadia Islam',
                        stars: 5,
                        text: 'ভয়েস এবং সাউন্ড কোয়ালিটি একদম ক্লিয়ার। ধন্যবাদ আপলোড করার জন্য।',
                        date: '5h ago',
                      },
                      {
                        id: 'c3',
                        author: 'Rohan Khan',
                        stars: 4,
                        text: 'Server 1 এ ক্লিক করার সাথে সাথেই প্লে হয়েছে!',
                        date: '1d ago',
                      },
                    ].map((rev) => (
                      <div
                        key={rev.id}
                        className="bg-[#121418] border border-white/[0.06] rounded-xl p-3 space-y-1"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-white">{rev.author}</span>
                          <span className="text-[11px] text-gray-400">{rev.date}</span>
                        </div>
                        <p className="text-xs text-gray-300 leading-relaxed">{rev.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* TAB 3: "Info >" Details, Cast & Screenshots Panel */}
              {bottomTab === 'infoCast' && (
                <div className="space-y-4 bg-[#121418] border border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white">Synopsis & Cast</h3>
                    <button
                      type="button"
                      onClick={() => setBottomTab('forYou')}
                      className="text-xs text-[#ef4444] font-bold"
                    >
                      Back to For You
                    </button>
                  </div>
                  <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
                    {effectiveDetail?.storyline ||
                      `${effectiveDetail?.title || movie.title} (${displayYear}) — Stream in Full HD with crystal clear audio on CinePulse.`}
                  </p>
                  {combinedCast.length > 0 && (
                    <div className="flex items-center gap-3 overflow-x-auto no-scrollbar pt-1">
                      {combinedCast.map((actor, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => {
                            onClose();
                            onSearchByActor(actor.name);
                          }}
                          className="w-20 shrink-0 flex flex-col items-center text-center"
                        >
                          <div className="w-14 h-14 rounded-full overflow-hidden bg-[#1b1d21] border border-white/10 mb-1.5">
                            {actor.photo ? (
                              <img
                                src={actor.photo}
                                alt={actor.name}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-400 font-bold text-xs">
                                {actor.name.charAt(0)}
                              </div>
                            )}
                          </div>
                          <span className="text-[11px] font-semibold text-white truncate w-full">
                            {actor.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Download Links Sheet Modal (Opens when tapping [ Download ] pill) */}
            {showDownloadSheet && (
              <div
                onClick={() => setShowDownloadSheet(false)}
                className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-end sm:items-center justify-center p-3 sm:p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#121418] border border-white/15 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden shadow-2xl"
                >
                  <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <Download className="w-4 h-4 text-[#ef4444]" />
                      <span>Direct High-Speed Downloads</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setShowDownloadSheet(false)}
                      className="w-8 h-8 rounded-lg bg-[#1b1d21] text-gray-300 flex items-center justify-center"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="p-4 overflow-y-auto space-y-2.5">
                    {combinedDownloads.length > 0 ? (
                      combinedDownloads.map((dl, idx) => (
                        <a
                          key={idx}
                          href={dl.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full px-4 py-3 rounded-xl bg-[#1b1d21] hover:bg-[#25282e] border border-white/10 flex items-center justify-between gap-3 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-white truncate">{dl.label}</div>
                            {dl.subLabel && (
                              <div className="text-[11px] text-gray-400 truncate">{dl.subLabel}</div>
                            )}
                          </div>
                          <Download className="w-4 h-4 text-[#ef4444] shrink-0" />
                        </a>
                      ))
                    ) : (
                      <p className="text-xs text-gray-400 text-center py-4">
                        Direct download links are preparing for this title.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Full All-Episodes Modal */}
            {showAllEpisodesModal && (
              <div
                onClick={() => setShowAllEpisodesModal(false)}
                className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xs flex items-center justify-center p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#121418] border border-white/15 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-2xl"
                >
                  <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <h3 className="text-base font-bold text-white">
                      All Episodes ({filteredEpisodesWithIdx.length})
                    </h3>
                    <button
                      type="button"
                      onClick={() => setShowAllEpisodesModal(false)}
                      className="w-8 h-8 rounded-lg bg-[#1b1d21] hover:bg-[#25282e] text-gray-300 flex items-center justify-center"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="p-4 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2.5">
                    {filteredEpisodesWithIdx.map(({ ep, idx }) => {
                      const isSelected = idx === selectedEpIdx;
                      const rawBadge = formatEpisodeTileBadge(ep, idx);
                      const badgeStr = rawBadge === 'Movie' ? '01' : rawBadge;
                      return (
                        <button
                          key={ep.id || idx}
                          type="button"
                          onClick={() => {
                            handleSelectEpisode(idx);
                            setShowAllEpisodesModal(false);
                          }}
                          className={`h-12 px-2 rounded-xl text-sm font-semibold flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-gradient-to-br from-[#dc2626]/30 to-[#7f1d1d]/35 border border-[#dc2626]/60 text-[#ef4444] font-bold'
                              : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                          }`}
                        >
                          {badgeStr}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Fullscreen Screenshot Lightbox Modal */}
            {lightboxImage && (
              <div
                onClick={() => setLightboxImage(null)}
                className="fixed inset-0 z-50 bg-black/95 backdrop-blur-xs flex items-center justify-center p-4"
              >
                <button
                  type="button"
                  onClick={() => setLightboxImage(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                >
                  <X className="w-6 h-6" />
                </button>
                <img
                  src={lightboxImage}
                  alt="Screenshot Fullview"
                  referrerPolicy="no-referrer"
                  className="max-w-full max-h-[90vh] object-contain rounded-lg border border-white/15 shadow-2xl"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

