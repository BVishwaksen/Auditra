//importing the required libraries and hooks from React
import React, { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import {
  FaMicrophone,
  FaPlay,
  FaStop,
  FaCopy,
  FaFileAlt,
  FaFileDownload,
  FaEraser,
  FaWifi,
  FaMicrophoneSlash,
  FaSync,
  FaTimes,
  FaExclamationTriangle,
  FaCheckCircle,
} from "react-icons/fa";

//Importing the icons from react-icons
import { MdSignalWifiOff, MdTab } from "react-icons/md";

//Importing the necessary constants
import { API_BASE,CHUNK_DURATION,OVERLAP_DURATION,MAX_OFFLINE_CHUNKS,MAX_RETRY_ATTEMPTS,SYNC_BATCH_SIZE } from "./utils/Constants";


//Configuring the basic interfaces for type safety

/**
 * Interface representing a browser tab with audio capture capabilities
 */
interface Tab {
  id: number;
  title: string;
  active: boolean;
  url?: string;
  favIconUrl?: string;
}

/**
 * Interface for audio chunks that are stored offline when network is unavailable
 */
interface OfflineChunk {
  blob: Blob;
  chunkIndex: number;
  timestamp: number;
  isLastChunk?: boolean;
  retryCount?: number;
  sessionId: string;
  id: string;
}

/**
 * Interface for processed transcript chunks with metadata
 */
interface TranscriptChunk {
  text: string;
  chunkIndex: number;
  timestamp: string;
  source: "tab" | "microphone" | "mixed";
  isLastChunk?: boolean;
  tabTitle?: string;
}

/**
 * Interface for system error/info logging
 */
interface ErrorLog {
  id: number;
  message: string;
  timestamp: string;
  type: 'error' | 'warning' | 'info';
}

/**
 * Interface for managing the offline sync queue with different states
 */
interface SyncQueue {
  pending: OfflineChunk[];
  processing: Set<string>;
  failed: OfflineChunk[];
  completed: Set<string>;
}

/**
 * Asynchronous function to retrieve available Chrome tabs
 * Prioritizes tabs with audio content for better user experience
 * @returns Promise<chrome.tabs.Tab[]> Array of available tabs
 */
const getChromeTabs = async (): Promise<chrome.tabs.Tab[]> => {
  try {
    if (typeof chrome !== "undefined" && chrome.tabs) {
      // Get all tabs with audio (not just current window) for multi-tab support
      const allTabs = await chrome.tabs.query({});
      // Filter tabs that are likely to have audio
      const audioTabs = allTabs.filter(tab => 
        tab.url && 
        (tab.audible || 
         tab.url.includes('meet.google.com') ||
         tab.url.includes('zoom.us') ||
         tab.url.includes('teams.microsoft.com') ||
         tab.url.includes('youtube.com') ||
         tab.url.includes('spotify.com'))
      );
      return audioTabs.length > 0 ? audioTabs : allTabs.slice(0, 10); // Fallback to first 10 tabs
    } else {
      //Mock data for development
      return [
        {
          id: 1,
          title: "Google Meet - Daily Standup",
          active: true,
          url: "https://meet.google.com/abc-def-ghi",
          favIconUrl: "https://meet.google.com/favicon.ico",
          audible: true,
        },
        {
          id: 2,
          title: "YouTube - Tutorial Video",
          active: false,
          url: "https://youtube.com/watch?v=example",
          favIconUrl: "https://youtube.com/favicon.ico",
          audible: true,
        },
        {
          id: 3,
          title: "Microsoft Teams - Team Meeting",
          active: false,
          url: "https://teams.microsoft.com/meeting",
          favIconUrl: "https://teams.microsoft.com/favicon.ico",
          audible: false,
        },
        {
          id: 4,
          title: "Spotify - Relaxing Music",
          active: false,
          url: "https://open.spotify.com/playlist/example",
          favIconUrl: "https://spotify.com/favicon.ico",
          audible: true,
        },
      ] as unknown as chrome.tabs.Tab[];
    }
  } catch (err) {
    throw new Error(`Failed to get Chrome tabs: ${err}`);
  }
};

/**
 * Function to get media stream ID for tab audio capture
 * Required for Chrome's tabCapture API to access tab audio
 * @param tabId - The ID of the tab to capture audio from
 * @returns Promise<string> - Media stream ID for the specified tab
 */
const getStreamId = async (tabId: number): Promise<string> => {
  try {
    // Check if Chrome tabCapture API is available
    if (typeof chrome !== "undefined" && chrome.tabCapture) {
      return new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId(
          {
            targetTabId: tabId,
            consumerTabId: chrome.tabs ? undefined : tabId,
          },
          (id) => {
            // Handle Chrome runtime errors
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(id);
          }
        );
      });
    } else return "mock-stream-id";
  } catch (err) {
    throw new Error(`Failed to get stream ID: ${err}`);
  }
};

/**
 * Main App component - Chrome Extension Audio Capture and Transcription
 * Handles real-time audio capture from browser tabs with optional microphone input,
 * processes audio in chunks with overlap, and provides offline buffering capabilities
 */
const App: React.FC = () => {
  // Refs
  const tabStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioOutputRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const finalStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const processedChunksRef = useRef<Set<number>>(new Set());
  const retryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const syncQueueRef = useRef<SyncQueue>({
    pending: [],
    processing: new Set(),
    failed: [],
    completed: new Set(),
  });
  const transcriptContainerRef = useRef<HTMLDivElement>(null);

  // Set up REF DECLARATIONS - for persistent references
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [includeMic, setIncludeMic] = useState(false);
  const [status, setStatus] = useState("Ready to Record");
  const [duration, setDuration] = useState(0);
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chunkCounter, setChunkCounter] = useState(0);
  const [debugLog, setDebugLog] = useState("");
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [offlineChunks, setOfflineChunks] = useState<OfflineChunk[]>([]);
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [currentTabInfo, setCurrentTabInfo] = useState<Tab | null>(null);
  const [audioLevels, setAudioLevels] = useState({ tab: 0, mic: 0 });
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [micPermissionStatus, setMicPermissionStatus] = useState<"unknown" | "granted" | "denied" | "prompt">("unknown");
  const [showMicPermissionModal, setShowMicPermissionModal] = useState(false);
  const [micPermissionError, setMicPermissionError] = useState<string>("");
  const [syncStats, setSyncStats] = useState({
    totalBuffered: 0,
    syncing: 0,
    failed: 0,
    completed: 0,
  });
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  //Method For Error Logging
  const addErrorLog = useCallback((message: string, type: 'error' | 'warning' | 'info' = 'error') => {
    const error: ErrorLog = {
      id: Date.now(),
      message,
      timestamp: new Date().toISOString(),
      type,
    };
    setErrorLogs((prev) => [...prev, error].slice(-50)); // Keep more logs for better debugging
  }, []);

  //Method for clearing error logs
  const clearErrorLogs = () => {
    setErrorLogs([]);
  };

  //Method for Adding debug logs
  //This is only for development purpose and not intended to move to production environment
  const addDebugLog = useCallback((message: string) => {
    console.log(`[Chrome Extension Audio Capture] ${message}`);
    setDebugLog((prev) => `${prev}\n${new Date().toISOString()}: ${message}`);
  }, []);

  //Method to sync chunks stored in offline
  const updateSyncStats = useCallback(() => {
    const queue = syncQueueRef.current;
    setSyncStats({
      totalBuffered: queue.pending.length + queue.failed.length,
      syncing: queue.processing.size,
      failed: queue.failed.length,
      completed: queue.completed.size,
    });
  }, []);

  // Enhanced audio buffering system with better error handling
  const bufferAudioChunk = useCallback((
    blob: Blob,
    chunkIndex: number,
    currentSessionId: string,
    isLastChunk: boolean = false
  ) => {
    if (!currentSessionId) {
      return;
    }

    const chunkId = `${currentSessionId}-${chunkIndex}-${Date.now()}`;
    const bufferedChunk: OfflineChunk = {
      id: chunkId,
      blob,
      chunkIndex,
      timestamp: Date.now(),
      isLastChunk,
      retryCount: 0,
      sessionId: currentSessionId,
    };

    // Add to pending queue
    syncQueueRef.current.pending.push(bufferedChunk);
    
    // Update state for UI
    setOfflineChunks(prev => {
      const updated = [...prev, bufferedChunk];
      if (updated.length > MAX_OFFLINE_CHUNKS) {
        const removed = updated.shift();
        if (removed) {
          // Remove from sync queue as well
          const queue = syncQueueRef.current;
          queue.pending = queue.pending.filter(c => c.id !== removed.id);
        }
      }
      return updated;
    });

    updateSyncStats();
  }, [addDebugLog, addErrorLog, updateSyncStats]);

  // Enhanced retry mechanism with exponential backoff as per requirements
  const retryFailedChunk = useCallback(async (chunk: OfflineChunk): Promise<boolean> => {
    const backoffDelay = Math.min(1000 * Math.pow(2, chunk.retryCount || 0), 30000);
    
    await new Promise(resolve => setTimeout(resolve, backoffDelay));

    try {
      await sendAudioChunkDirect(chunk.blob, chunk.sessionId, chunk.chunkIndex, chunk.isLastChunk);
      
      // Mark as completed
      const queue = syncQueueRef.current;
      queue.completed.add(chunk.id);
      queue.processing.delete(chunk.id);
      return true;
    } catch (error) {
      chunk.retryCount = (chunk.retryCount || 0) + 1;
      
      if (chunk.retryCount >= MAX_RETRY_ATTEMPTS) {
        // Move to failed queue
        const queue = syncQueueRef.current;
        queue.failed.push(chunk);
        queue.processing.delete(chunk.id);
        return false;
      } else {
        return false;
      }
    }
  }, [addDebugLog, addErrorLog]);

  // Direct API call with comprehensive error handling
  const sendAudioChunkDirect = async (
    blob: Blob,
    currentSessionId: string,
    chunkIndex: number,
    isLastChunk: boolean = false
  ): Promise<string> => {
    if (!currentSessionId) {
      throw new Error("No session ID available");
    }

    // Prepare form data for multipart upload
    const form = new FormData();
    form.append("audio", blob, `chunk_${chunkIndex}.webm`);
    form.append("chunkIndex", chunkIndex.toString());
    form.append("timestamp", Date.now().toString());
    form.append("hasOverlap", "true");
    form.append("overlapDuration", OVERLAP_DURATION.toString());

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
      // Send POST request to transcription API
      const res = await fetch(`${API_BASE}/api/chunk/${currentSessionId}`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      // Clear the timeout on successful response
      clearTimeout(timeoutId);

      // Check for HTTP errors
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      // Return transcribed text
      const text = await res.text();
      return text;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout - chunk processing took too long');
      }
      throw error;
    }
  };

  // Enhanced sync processing with batching and better error messages
  const processSyncQueue = useCallback(async () => {
    const queue = syncQueueRef.current;
    
    if (queue.pending.length === 0 || !isOnline) {
      return;
    }

    // Process chunks in batches for better performance
    const batch = queue.pending.splice(0, SYNC_BATCH_SIZE);
    
    if (batch.length > 0) {
      setStatus(`Syncing ${batch.length} audio chunks...`);
    }

    const promises = batch.map(async (chunk) => {
      if (queue.processing.has(chunk.id)) {
        return; // Already processing
      }

      queue.processing.add(chunk.id);

      try {
        const text = await sendAudioChunkDirect(
          chunk.blob,
          chunk.sessionId,
          chunk.chunkIndex,
          chunk.isLastChunk
        );

        // Success - add to transcript and mark completed
        if (text && !processedChunksRef.current.has(chunk.chunkIndex)) {
          appendTranscriptChunk(text, chunk.chunkIndex, chunk.isLastChunk);
        }
        
        queue.completed.add(chunk.id);
        queue.processing.delete(chunk.id);
        
        // Remove from offline chunks state
        setOfflineChunks(prev => prev.filter(c => c.id !== chunk.id));
      } catch (error) {
        
        // Retry logic
        const success = await retryFailedChunk(chunk);
        if (!success && chunk.retryCount && chunk.retryCount >= MAX_RETRY_ATTEMPTS) {
          // Remove from offline chunks if permanently failed
          setOfflineChunks(prev => prev.filter(c => c.id !== chunk.id));
        } else if (!success) {
          // Put back in pending queue for next retry
          queue.pending.unshift(chunk);
        } else {
          // Success on retry
          setOfflineChunks(prev => prev.filter(c => c.id !== chunk.id));
        }
      }
    });

    await Promise.allSettled(promises);
    updateSyncStats();

    // Update status based on sync completion
    if (queue.pending.length === 0 && queue.processing.size === 0) {
      setStatus(recording ? "Recording..." : "Sync completed");
    }
  }, [isOnline, addDebugLog, retryFailedChunk, updateSyncStats, recording]);

  // Auto-sync when connection restored with better user feedback
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setStatus("Connection restored - syncing...");
      
      // Start continuous sync
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      
      // Process immediately and then every 2 seconds
      processSyncQueue();
      syncIntervalRef.current = setInterval(processSyncQueue, 2000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setStatus("Offline - buffering audio...");
      
      // Stop sync processing
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Start sync if already online
    if (isOnline && syncQueueRef.current.pending.length > 0) {
      handleOnline();
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [processSyncQueue, addDebugLog, addErrorLog]);

  /**
   * Manual retry function for failed chunks with better user feedback
   * Allows users to manually retry all failed chunks
   */
  const retryFailedChunks = useCallback(async () => {
    const queue = syncQueueRef.current;
    
    if (queue.failed.length === 0) {
      return;
    }

    setRetryingConnection(true);
    setStatus(`Retrying ${queue.failed.length} failed chunks...`);

    // Move failed chunks back to pending
    const failedChunks = [...queue.failed];
    queue.failed = [];
    
    // Reset retry counts for manual retry
    failedChunks.forEach(chunk => {
      chunk.retryCount = 0;
      queue.pending.push(chunk);
    });

    updateSyncStats();
    
    /**
   * Enhanced sync processing with batching and better error messages
   * Processes the offline chunk queue in batches for better performance
   * Only runs when online and chunks are available
   */
    await processSyncQueue();
    
    setRetryingConnection(false);
  }, [addDebugLog, addErrorLog, processSyncQueue, updateSyncStats]);

  // Pause/Resume functionality as per requirements
  const pauseRecording = () => {
    if (!recording || paused) return;
    setPaused(true);
    setStatus("Recording Paused");
    
    if (recorderRef.current && typeof (recorderRef.current as any).pause === 'function') {
      (recorderRef.current as any).pause();
    }
    
    // Stop timer
    stopTimer();
  };

  const resumeRecording = () => {
    if (!recording || !paused) return;
    setPaused(false);
    setStatus("Recording...");
    
    if (recorderRef.current && typeof (recorderRef.current as any).resume === 'function') {
      (recorderRef.current as any).resume();
    }
    // Resume timer
    startTimer();
  };

  // Clear completed chunks from memory periodically for performance
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const queue = syncQueueRef.current;
      
      // Keep only recent completed chunks (last 100) for memory management
      if (queue.completed.size > 100) {
        const completedArray = Array.from(queue.completed);
        const toKeep = completedArray.slice(-50);
        queue.completed = new Set(toKeep);
        updateSyncStats();
      }
    }, 60000); // Cleanup every minute

    return () => clearInterval(cleanupInterval);
  }, [updateSyncStats, addDebugLog]);

  const checkMicrophonePermission = async (): Promise<PermissionState> => {
    try {
      if ("permissions" in navigator) {
        const permissionStatus = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        setMicPermissionStatus(permissionStatus.state);
        permissionStatus.onchange = () => {
          setMicPermissionStatus(permissionStatus.state);
        };

        return permissionStatus.state;
      }
    } catch (err) {
      const errorMessage = `Error checking microphone permission: ${err}`;
      addErrorLog(errorMessage);
    }
    return "prompt";
  };

  /**
   * Requests microphone permission from the user
   * Attempts to access microphone to trigger permission prompt
   * @returns Promise<boolean> - Whether permission was granted
   */
  const requestMicrophonePermission = async (): Promise<boolean> => {
    try {
      setMicPermissionError("");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
        },
      });

      setMicPermissionStatus("granted");
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err: any) {
      const errorMessage = `Microphone permission error: ${err.message}`;

      if (err.name === "NotAllowedError") {
        setMicPermissionStatus("denied");
        setMicPermissionError(
          "Microphone access was denied. Please click on the extension icon and enable microphone permissions."
        );
      } else if (err.name === "NotFoundError") {
        setMicPermissionStatus("denied");
        setMicPermissionError(
          "No microphone device found. Please connect a microphone and try again."
        );
      } else if (err.name === "NotReadableError") {
        setMicPermissionStatus("denied");
        setMicPermissionError(
          "Microphone is currently being used by another application."
        );
      } else {
        setMicPermissionStatus("denied");
        setMicPermissionError(`Microphone error: ${err.message}`);
      }

      setShowMicPermissionModal(true);
      return false;
    }
  };

  useEffect(() => {
    checkMicrophonePermission();
  }, []);

  /**
   * Handles microphone toggle with permission checking
   * @param enabled - Whether microphone should be enabled
   */
  const handleMicrophoneToggle = async (enabled: boolean) => {
    if (recording) return;

    if (enabled) {
      const permissionStatus = await checkMicrophonePermission();

      if (permissionStatus === "denied") {
        setMicPermissionError(
          "Microphone permission was previously denied. Please enable it in your browser settings."
        );
        setShowMicPermissionModal(true);
        return;
      }

      if (permissionStatus === "prompt") {
        const granted = await requestMicrophonePermission();
        if (!granted) {
          return;
        }
      }

      setIncludeMic(true);
    } else {
      setIncludeMic(false);
    }
  };

  // Enhanced tab loading with better audio tab detection
  useEffect(() => {
    const loadTabs = async () => {
      try {
        const chromeTabs: chrome.tabs.Tab[] = await getChromeTabs();
        const filteredTabs: Tab[] = chromeTabs
          .filter(
            (t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined
          )
          .map((t) => ({
            id: t.id!,
            title: t.title || `Tab ${t.id}`,
            active: t.active ?? false,
            url: t.url,
            favIconUrl: t.favIconUrl,
          }));

        setTabs(filteredTabs);
        
        // Prioritize active tab or first audible tab
        const activeTab = filteredTabs.find((t) => t.active);
        const audibleTab = filteredTabs.find((t) => 
          t.url && (
            t.url.includes('meet.google.com') ||
            t.url.includes('zoom.us') ||
            t.url.includes('teams.microsoft.com')
          )
        );
        
        const selectedTab = audibleTab || activeTab || filteredTabs[0];
        if (selectedTab) {
          setSelectedTabId(selectedTab.id);
          setCurrentTabInfo(selectedTab);
        }
        
        if (filteredTabs.length === 0) {
          addErrorLog("No suitable tabs found for audio capture", 'info');
        }
      } catch (err) {
        const errorMessage = `Error loading tabs: ${err}`;
      }
    };
    loadTabs();
  }, [addDebugLog, addErrorLog]);

  useEffect(() => {
    const selectedTab = tabs.find((t) => t.id === selectedTabId);
    setCurrentTabInfo(selectedTab || null);
  }, [selectedTabId, tabs]);

   /**
   * Formats duration in seconds to HH:MM:SS format
   * @param s - Duration in seconds
   * @returns Formatted time string
   */

  const formatTime = (s: number) => {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  /**
   * Starts the recording duration timer
   * Handles both initial start and resume from pause
   */
  const startTimer = () => {
    if (paused) {
      // Resume from where we left off
      const pausedDuration = duration;
      recordingStartTimeRef.current = Date.now() - (pausedDuration * 1000);
    } else {
      recordingStartTimeRef.current = Date.now();
      setDuration(0);
    }
    
    timerIntervalRef.current = setInterval(
      () => setDuration((d) => d + 1),
      1000
    );
  };

  /**
   * Stops the recording duration timer
   */
  const stopTimer = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = null;
  };

  /**
   * Enhanced timestamp formatting with configurable intervals
   * Creates timestamp ranges for each audio chunk
   * @param chunkNum - The chunk number to create timestamp for
   * @param isLastChunk - Whether this is the final chunk
   * @param actualEndTime - Actual end time for final chunk calculation
   * @returns Formatted timestamp string or empty string if timestamps disabled
   */
  const formatTimestampRange = (
    chunkNum: number,
    isLastChunk: boolean = false,
    actualEndTime?: number
  ) => {
    const startSec = (chunkNum * (CHUNK_DURATION - OVERLAP_DURATION)) / 1000;
    let endSec: number;

    if (isLastChunk && actualEndTime) {
      const totalRecordingTime =
        (actualEndTime - recordingStartTimeRef.current) / 1000;
      endSec = Math.floor(totalRecordingTime);
    } else {
      endSec = startSec + CHUNK_DURATION / 1000;
    }

    // Helper function to format seconds to MM:SS format
    const formatTimeForTimestamp = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return showTimestamps ? 
      `[${formatTimeForTimestamp(Math.floor(startSec))} - ${formatTimeForTimestamp(Math.floor(endSec))}]` : 
      '';
  };

  /**
   * Determines the source label based on current recording configuration
   * @param includeMic - Whether microphone is included in recording
   * @returns Source type for labeling transcript chunks
   */
  const getSourceLabel = (
    includeMic: boolean
  ): "tab" | "microphone" | "mixed" => {
    if (!includeMic) return "tab";
    return "mixed";
  };

  /**
   * Returns appropriate icon component for different audio sources
   * @param source - The audio source type
   * @returns JSX element with appropriate icon(s)
   */
  const getSourceIcon = (source: "tab" | "microphone" | "mixed") => {
    switch (source) {
      case "tab":
        return <MdTab className="source-icon tab-icon" title="Tab Audio" />;
      case "microphone":
        return <FaMicrophone className="source-icon mic-icon" title="Microphone" />;
      case "mixed":
        return (
          <div className="mixed-sources" title="Tab + Microphone">
            <MdTab className="source-icon tab-icon" />
            <FaMicrophone className="source-icon mic-icon" />
          </div>
        );
    }
  };

  /**
   * Appends a new transcript chunk to the display
   * Handles deduplication and auto-scrolling
   * @param text - Transcribed text content
   * @param chunkNum - Sequential chunk number
   * @param isLastChunk - Whether this is the final chunk
   */
  const appendTranscriptChunk = (
    text: string,
    chunkNum: number,
    isLastChunk: boolean = false
  ) => {
    if (!text) return;

    if (processedChunksRef.current.has(chunkNum)) {
      return;
    }

    processedChunksRef.current.add(chunkNum);

    const timestamp = formatTimestampRange(
      chunkNum,
      isLastChunk,
      isLastChunk ? Date.now() : undefined
    );
    const source = getSourceLabel(includeMic);

    const newChunk: TranscriptChunk = {
      text,
      chunkIndex: chunkNum,
      timestamp,
      source,
      isLastChunk,
      tabTitle: currentTabInfo?.title,
    };

    setTranscriptChunks((prev) => {
      const updated = [...prev, newChunk];
      
      // Auto-scroll to bottom if enabled
      if (autoScroll && transcriptContainerRef.current) {
        setTimeout(() => {
          transcriptContainerRef.current?.scrollTo({
            top: transcriptContainerRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }, 100);
      }
      
      return updated;
    });
    
  };

  /**
   * Clears all transcript data and resets chunk tracking
   * Also clears the offline sync queue
   */
  const clearTranscript = () => {
    setTranscriptChunks([]);
    setChunkCounter(0);
    processedChunksRef.current.clear();
    setOfflineChunks([]);
    
    // Clear sync queue
    const queue = syncQueueRef.current;
    queue.pending = [];
    queue.processing.clear();
    queue.failed = [];
    queue.completed.clear();
    
    updateSyncStats();
  };

  /**
   * Sets up real-time audio level monitoring for visual feedback
   * Creates Web Audio API analyzers for both tab and microphone streams
   * @param tabStream - MediaStream from the selected tab
   * @param micStream - Optional MediaStream from microphone
   */
  const setupAudioLevelMonitoring = (
    tabStream: MediaStream,
    micStream?: MediaStream
  ) => {
    if (!audioCtxRef.current) return;
    /**
     * Helper function to analyze audio levels from a stream
     * @param stream - MediaStream to analyze
     * @param callback - Function to call with level updates (0-1 range)
     */
    const analyzeAudio = (
      stream: MediaStream,
      callback: (level: number) => void
    ) => {
      try {
        const source = audioCtxRef.current!.createMediaStreamSource(stream);
        const analyzer = audioCtxRef.current!.createAnalyser();
        analyzer.fftSize = 256; // FFT size for frequency analysis
        analyzer.smoothingTimeConstant = 0.3; // Smoothing for less jittery readings
        source.connect(analyzer);

        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        /**
         * Recursive function to continuously update audio levels
         */
        const updateLevel = () => {
          if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
            analyzer.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
            callback(Math.min(average / 255, 1.0)); // Ensure level is between 0 and 1
            // Schedule next update
            requestAnimationFrame(updateLevel);
          }
        };
        updateLevel();
      } catch (err) {
        const errorMessage = `Error setting up audio level monitoring: ${err}`;
      }
    };

     // Set up monitoring for tab audio
    analyzeAudio(tabStream, (level) => {
      setAudioLevels((prev) => ({ ...prev, tab: level }));
    });

    // Set up monitoring for microphone audio if available
    if (micStream) {
      analyzeAudio(micStream, (level) => {
        setAudioLevels((prev) => ({ ...prev, mic: level }));
      });
    }
  };

   /**
   * Sets up the complete audio capture pipeline
   * Handles both tab audio and optional microphone input
   * Creates proper audio routing and channel management
   * @returns Object containing final stream and channel count
   */
  const getFinalStreamAndChannelCount = async () => {
    // Validate tab selection
    if (!selectedTabId) {
      const errorMessage = "Please Make sure that there is an active tab. If that does not work please open the extension in the tab t where you want to capture the audio";
      addErrorLog(errorMessage);
      throw new Error(errorMessage);
    }
    // Get stream ID for tab capture
    let streamId: string;
    try {
      streamId = await getStreamId(selectedTabId);
    } catch (err) {
      const errorMessage = "Please Make sure that there is an active tab. If that does not work please open the extension in the tab t where you want to capture the audio";
      addErrorLog(errorMessage);
      throw new Error(errorMessage);
    }

    // Set up tab audio capture
    let tabStream: MediaStream | null = null;
    try {
      // Use Chrome's tab capture API with specific constraints
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
            chromeMediaSourceLoopback: true,
          },
        } as any,
      });
    } catch (err) {
      try {
        // Fallback: create synthetic audio source for testing/development
        const audioCtx = new AudioContext();
        const oscillator = audioCtx.createOscillator();
        const dest = audioCtx.createMediaStreamDestination();
        oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // A4 note
        oscillator.type = 'sine';
        oscillator.connect(dest);
        oscillator.start();
        tabStream = dest.stream;
      } catch (fallbackErr) {
        const errorMessage = `Failed to create fallback audio source: ${fallbackErr}`;
        throw new Error(errorMessage);
      }
    }
    tabStreamRef.current = tabStream;

    // Create Web Audio API context for audio processing
    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioContext({ sampleRate: 48000 });
      audioCtxRef.current = audioCtx;
    } catch (err) {
      const errorMessage = `Failed to create AudioContext: ${err}`;
      throw new Error(errorMessage);
    }

    // Create audio source node from tab stream
    let tabSource: MediaStreamAudioSourceNode;
    try {
      tabSource = audioCtx.createMediaStreamSource(tabStream);
    } catch (err) {
      const errorMessage = `Failed to create tab audio source node: ${err}`;
      throw new Error(errorMessage);
    }

    // Create destination node for final mixed audio
    let audioOutput: MediaStreamAudioDestinationNode;
    try {
      audioOutput = audioCtx.createMediaStreamDestination();
      audioOutputRef.current = audioOutput;
    } catch (err) {
      const errorMessage = `Failed to create audio output destination: ${err}`;
      throw new Error(errorMessage);
    }

    // Create gain node for volume control
    let gainNode: GainNode;
    try {
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.0;
    } catch (err) {
      const errorMessage = `Failed to create gain node: ${err}`;
      throw new Error(errorMessage);
    }

    // Initialize with tab-only configuration
    let stream: MediaStream = tabStream;
    let channels = 1;

    if (includeMic) {
      try {
        const permissionStatus = await checkMicrophonePermission();

        if (permissionStatus === "denied") {
          throw new Error("Microphone permission denied");
        }
        // Get microphone stream with noise reduction settings
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          },
        });

        micStreamRef.current = micStream;
        // Create microphone source node
        const micSource = audioCtx.createMediaStreamSource(micStream);
        const merger = audioCtx.createChannelMerger(2);

        // Channel 0: Tab audio
        tabSource.connect(merger, 0, 0);
        tabSource.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Channel 1: Microphone audio
        micSource.connect(merger, 0, 1);

        merger.connect(audioOutput);
        stream = audioOutput.stream;
        channels = 2;

        setupAudioLevelMonitoring(tabStream, micStream);
      } catch (err: any) {
        // Handling microphone errors gracefully so that the system fall back to tab-only
        if (err.name === "NotAllowedError") {
          setMicPermissionError(
            "Microphone permission was denied. Recording will continue with tab audio only."
          );
        } else if (err.name === "NotFoundError") {
          setMicPermissionError(
            "No microphone device found. Recording will continue with tab audio only."
          );
        } else if (err.name === "NotReadableError") {
          setMicPermissionError(
            "Microphone is in use by another application. Recording will continue with tab audio only."
          );
        } else {
          setMicPermissionError(
            `Microphone error: ${err.message}. Recording will continue with tab audio only.`
          );
        }

        // Show error modal and disable microphone
        setShowMicPermissionModal(true);
        setIncludeMic(false);
        setMicPermissionStatus("denied");

        // Fallback to tab-only setup
        tabSource.connect(audioOutput);
        tabSource.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        stream = audioOutput.stream;
        channels = 1;
        setupAudioLevelMonitoring(tabStream);
      }
    } else {
      // Tab-only audio setup
      tabSource.connect(audioOutput);
      tabSource.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      stream = audioOutput.stream;
      channels = 1;
      setupAudioLevelMonitoring(tabStream);
    }

    // Store final stream reference and return configuration
    finalStreamRef.current = stream;
    return { finalStream: stream, channelCount: channels };
  };

  /**
   * Modal component for handling microphone permission issues
   * Provides user-friendly instructions and retry options
   * @returns JSX element or null if modal shouldn't be shown
   */
  const MicrophonePermissionModal = () => {
    if (!showMicPermissionModal) return null;

    return (
      <div className="permission-modal-overlay">
        <div className="permission-modal">
          {/* Modal header with close button */}
          <div className="modal-header">
            <h3>Microphone Permission</h3>
            <button
              className="modal-close-btn"
              onClick={() => setShowMicPermissionModal(false)}
              title="Close"
            >
              <FaTimes />
            </button>
          </div>
          {/* Modal content with error message and instructions */}
          <div className="modal-content">
            <div className="permission-icon">🎤</div>
            <p>{micPermissionError}</p>
            {micPermissionStatus === "denied" && (
              <div className="permission-instructions">
                <p>
                  <strong>To enable microphone access:</strong>
                </p>
                <ol>
                  <li>Click the extension icon in your browser toolbar</li>
                  <li>Select "Allow" for microphone permissions</li>
                  <li>Refresh this page and try again</li>
                </ol>
              </div>
            )}
          </div>
          {/* Modal action buttons */}
          <div className="modal-actions">
            {/* Show retry button only if permission not permanently denied */}
            {micPermissionStatus !== "denied" && (
              <button
                className="modal-btn try-again-btn"
                onClick={async () => {
                  setShowMicPermissionModal(false);
                  const granted = await requestMicrophonePermission();
                  if (granted) {
                    setIncludeMic(true);
                  }
                }}
              >
                Continue
              </button>
            )}
            <button
              className="modal-btn continue-btn"
              onClick={() => {
                setShowMicPermissionModal(false);
                setIncludeMic(false);
              }}
            >
              Continue Without Microphone
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Enhanced audio chunk sending with smart buffering
  const sendAudioChunkWithSession = async (
    blob: Blob,
    currentSessionId: string,
    chunkIndex: number,
    isLastChunk: boolean = false
  ) => {
    if (!currentSessionId) {
      const errorMessage = "No session ID available for chunk processing";
      return;
    }

    if (processedChunksRef.current.has(chunkIndex)) {
      return;
    }

    // Check if we're online - if not, buffer immediately
    if (!isOnline) {
      bufferAudioChunk(blob, chunkIndex, currentSessionId, isLastChunk);
      return;
    }

    // Try to send immediately if online

    try {
      const text = await sendAudioChunkDirect(blob, currentSessionId, chunkIndex, isLastChunk);
      appendTranscriptChunk(text, chunkIndex, isLastChunk);
    } catch (err) {
      const errorMessage = `Failed to send chunk ${chunkIndex}: ${err}`;

      // Buffer on failure for later retry
      bufferAudioChunk(blob, chunkIndex, currentSessionId, isLastChunk);
    }
  };
/**
   * Creates a custom MediaRecorder wrapper with chunked recording capability
   * Implements 30-second chunks with automatic sequencing
   * @param stream - MediaStream to record from
   * @param mimeType - MIME type for audio encoding
   * @param currentSessionId - Session ID for API calls
   * @returns MediaRecorder-like object with enhanced chunking
   */
  const createRecorder = (
    stream: MediaStream,
    mimeType: string,
    currentSessionId: string
  ) => {
    if (!currentSessionId) {
      const errorMessage = "Cannot create recorder: no session ID available";
      return null;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      const errorMessage = "Warning: Audio stream has no active tracks";
    }

    // Recorder state variables
    let chunkIndex = 0;
    let currentRecorder: MediaRecorder | null = null;
    let isRecording = false;
    let chunkTimeout: NodeJS.Timeout | null = null;
    let finalChunkProcessed = false;
    let nextChunkTimeout: NodeJS.Timeout | null = null;

    const startSingleChunk = () => {
      if (!isRecording) return;

      try {
        currentRecorder = new MediaRecorder(stream, { 
          mimeType,
          audioBitsPerSecond: 128000 // 128 kbps for good quality
        });

        currentRecorder.ondataavailable = async (event) => {
          if (event.data && event.data.size > 0) {
            const currentChunkNum = chunkIndex;
           
            if (!processedChunksRef.current.has(currentChunkNum) && !finalChunkProcessed) {
              try {
                await sendAudioChunkWithSession(event.data, currentSessionId, currentChunkNum);
              } catch (err) {
                const errorMessage = `Error handling chunk ${currentChunkNum}: ${err}`;
              }
            }
          }
        };

        currentRecorder.onstop = () => {
          const stoppedChunkNum = chunkIndex;
          chunkIndex++;
          setChunkCounter(chunkIndex);

          if (isRecording && !finalChunkProcessed) {
            nextChunkTimeout = setTimeout(() => {
              if (isRecording) {
                startSingleChunk();
              }
            }, 100); // Brief delay between chunks
          }
        };

        currentRecorder.onstart = () => {
        };

        currentRecorder.onerror = (e) => {
          const errorMessage = `MediaRecorder error on chunk ${chunkIndex}: ${e}`;
        };

        currentRecorder.start();

        // Set 30-second timeout for this chunk
        chunkTimeout = setTimeout(() => {
          if (currentRecorder && currentRecorder.state === "recording") {
            currentRecorder.stop();
          }
        }, CHUNK_DURATION);
      } catch (err) {
        const errorMessage = `Error starting chunk ${chunkIndex}: ${err}`;
      }
    };

    const recorderWrapper = {
      start: () => {
        isRecording = true;
        chunkIndex = 0;
        finalChunkProcessed = false;
        setChunkCounter(0);
        processedChunksRef.current.clear();
        startSingleChunk();
      },

      stop: () => {
        return new Promise<void>((resolve) => {
          isRecording = false;
          finalChunkProcessed = true;

          if (chunkTimeout) {
            clearTimeout(chunkTimeout);
            chunkTimeout = null;
          }
          if (nextChunkTimeout) {
            clearTimeout(nextChunkTimeout);
            nextChunkTimeout = null;
          }

          if (currentRecorder) {
            if (currentRecorder.state === "recording") {
              currentRecorder.addEventListener(
                "dataavailable",
                async (event) => {
                  if (event.data && event.data.size > 0) {
                    try {
                      if (!processedChunksRef.current.has(chunkIndex)) {
                        await sendAudioChunkWithSession(event.data, currentSessionId, chunkIndex, true);
                      }
                    } catch (err) {
                      const errorMessage = `Error processing final chunk: ${err}`;
                    }
                  }
                  resolve();
                },
                { once: true }
              );

              currentRecorder.stop();
            } else {
              resolve();
            }
          } else {
            resolve();
          }
        });
      },

      pause: () => {
        isRecording = false;

        if (chunkTimeout) {
          clearTimeout(chunkTimeout);
          chunkTimeout = null;
        }
        if (nextChunkTimeout) {
          clearTimeout(nextChunkTimeout);
          nextChunkTimeout = null;
        }

        if (currentRecorder && currentRecorder.state === "recording") {
          currentRecorder.pause();
        }
      },

      resume: () => {
        isRecording = true;
        finalChunkProcessed = false;

        if (currentRecorder && currentRecorder.state === "paused") {
          currentRecorder.resume();
          chunkTimeout = setTimeout(() => {
            if (currentRecorder && currentRecorder.state === "recording") {
              currentRecorder.stop();
            }
          }, CHUNK_DURATION);
        } else {
          startSingleChunk();
        }
      },

      get state() {
        return currentRecorder ? currentRecorder.state : "inactive";
      },
    };

    return recorderWrapper as unknown as MediaRecorder;
  };

  const startRecording = async () => {
    if (recording) return;

    clearTranscript();
    setStatus("Initializing audio capture...");

    try {
      // Test server connection first
      const res = await fetch(`${API_BASE}/api/start`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`API server error ${res.status}: ${res.statusText}`);
      }
      const json = await res.json();
      const newSessionId = json.sessionId;
      setSessionId(newSessionId);

      const { finalStream } = await getFinalStreamAndChannelCount();

      // Determine best audio format
      const supportedTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];

      let mimeType = "audio/webm";
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }

      const recorder = createRecorder(finalStream, mimeType, newSessionId);
      if (!recorder) {
        throw new Error("Failed to create audio recorder");
      }

      recorderRef.current = recorder;

      recorder.start();

      setRecording(true);
      setPaused(false);
      setStatus("Recording...");
      startTimer();
      
      // Start sync queue processing if online
      if (isOnline && !syncIntervalRef.current) {
        syncIntervalRef.current = setInterval(processSyncQueue, 2000);
      }
    } catch (err: any) {
      const errorMessage = `Failed to start recording: ${err.message}`;
      console.error(err);
      setStatus("Error - Unable to start recording");
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current) return;
    setStatus("Processing final audio chunk...");
    try {
      await (recorderRef.current as any).stop();
    } catch (err) {
      const errorMessage = `Error processing final chunk: ${err}`;
    }

    setRecording(false);
    setPaused(false);
    stopTimer();

    // Clean up audio streams
    try {
      tabStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
    } catch (err) {
      const errorMessage = `Error cleaning up audio resources: ${err}`;
    }

    // Stop session on server
    if (sessionId) {
      try {
        const res = await fetch(`${API_BASE}/api/stop/${sessionId}`, {
          method: "POST",
        });
      } catch (err) {
        const errorMessage = `Error ending server session: ${err}`;
        addErrorLog(errorMessage, 'warning');
      } finally {
        setSessionId(null);
      }
    }

    // Continue syncing any remaining buffered chunks
    if (syncQueueRef.current.pending.length > 0) {
      setStatus(`Syncing ${syncQueueRef.current.pending.length} buffered chunks...`);
    } else {
      setStatus("Recording completed");
    }

    setChunkCounter(0);
    setAudioLevels({ tab: 0, mic: 0 });
    addErrorLog("Recording completed successfully", 'info');
  };

  const getFullTranscriptText = () => {
    return transcriptChunks
      .map((chunk) => {
        const timestampStr = showTimestamps ? `${chunk.timestamp} ` : '';
        const sourceStr = `[${chunk.source}${chunk.tabTitle ? ` - ${chunk.tabTitle}` : ''}] `;
        return `${timestampStr}${sourceStr}${chunk.text}`;
      })
      .join("\n");
  };

  const copyTranscript = async () => {
    try {
      const fullText = getFullTranscriptText();
      await navigator.clipboard.writeText(fullText);
      setStatus("Transcript copied to clipboard");
      setTimeout(() => setStatus(recording ? "Recording..." : "Recording completed"), 2000);
    } catch (err) {
      const errorMessage = `Failed to copy transcript: ${err}`;
      setStatus("Error copying transcript");
    }
  };

  const downloadTxt = () => {
    try {
      const fullText = getFullTranscriptText();
      const blob = new Blob([fullText], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transcript_${currentTabInfo?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'recording'}_${new Date().toISOString().split("T")[0]}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const errorMessage = `Failed to download TXT: ${err}`;
    }
  };

  const downloadJson = () => {
    try {
      const payload = {
        metadata: {
          createdAt: new Date().toISOString(),
          duration: formatTime(duration),
          totalChunks: chunkCounter,
          offlineChunksBuffered: offlineChunks.length,
          syncStats: syncStats,
          recordingSource: {
            tab: {
              title: currentTabInfo?.title,
              url: currentTabInfo?.url,
              id: currentTabInfo?.id,
            },
            microphone: includeMic,
            channels: includeMic ? 2 : 1,
          },
          configuration: {
            chunkDuration: CHUNK_DURATION,
            overlapDuration: OVERLAP_DURATION,
            showTimestamps: showTimestamps,
            autoScroll: autoScroll,
          }
        },
        transcriptChunks: transcriptChunks,
        fullTranscript: getFullTranscriptText(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transcript_${currentTabInfo?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'recording'}_${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const errorMessage = `Failed to download JSON: ${err}`;
      addErrorLog(errorMessage, 'warning');
    }
  };

  const clearDebugLog = () => {
    setDebugLog("");
  };

  const refreshTabs = async () => {
    try {
      const chromeTabs: chrome.tabs.Tab[] = await getChromeTabs();
      const filteredTabs: Tab[] = chromeTabs
        .filter(
          (t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined
        )
        .map((t) => ({
          id: t.id!,
          title: t.title || `Tab ${t.id}`,
          active: t.active ?? false,
          url: t.url,
          favIconUrl: t.favIconUrl,
        }));

      setTabs(filteredTabs);
    } catch (err) {
      const errorMessage = `Error refreshing tabs: ${err}`;
    }
  };

  //Sync status component with better visual feedback
  const SyncStatusIndicator = () => {
    if (syncStats.totalBuffered === 0 && syncStats.syncing === 0) return null;

    return (
      <div className="sync-status-indicator">
        <div className="sync-stats">
          {syncStats.totalBuffered > 0 && (
            <span className="buffered-count" title={`${syncStats.totalBuffered} chunks buffered offline`}>
              📦 {syncStats.totalBuffered}
            </span>
          )}
          {syncStats.syncing > 0 && (
            <span className="syncing-count" title={`${syncStats.syncing} chunks currently syncing`}>
              🔄 {syncStats.syncing}
            </span>
          )}
          {syncStats.failed > 0 && (
            <span className="failed-count" title={`${syncStats.failed} chunks failed - click retry button`}>
              ⚠️ {syncStats.failed}
            </span>
          )}
          {syncStats.completed > 0 && (
            <span className="completed-count" title={`${syncStats.completed} chunks successfully synced`}>
              ✅ {syncStats.completed}
            </span>
          )}
        </div>
        {syncStats.failed > 0 && (
          <button
            className="retry-failed-btn"
            onClick={retryFailedChunks}
            disabled={retryingConnection || !isOnline}
            title="Retry all failed chunks"
          >
            <FaSync className={retryingConnection ? "spinning" : ""} />
          </button>
        )}
      </div>
    );
  };

  // Audio level indicators for visual feedback
  const AudioLevelIndicator = ({ level, label, type }: { level: number, label: string, type: 'tab' | 'mic' }) => {
    const percentage = Math.min(level * 100, 100);
    const isActive = percentage > 5;
    
    return (
      <div className={`audio-level-indicator ${type} ${isActive ? 'active' : ''}`}>
        <span className="level-label">{label}</span>
        <div className="level-bar">
          <div 
            className="level-fill" 
            style={{ width: `${percentage}%` }}
          />
        </div>
        <span className="level-value">{Math.round(percentage)}%</span>
      </div>
    );
  };

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      // Cleanup intervals
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (retryIntervalRef.current) clearInterval(retryIntervalRef.current);
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      
      // Cleanup audio streams
      tabStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
    };
  }, []);

  return (
    <div className="app-container">
      {/* Error/Info Messages Modal */}
      {errorLogs.length > 0 && (
        <div className="error-overlay">
          <div className="error-modal">
            <div className="error-header">
              <h3>System Messages ({errorLogs.length})</h3>
              <button
                className="error-close-btn"
                onClick={clearErrorLogs}
                title="Close all messages"
              >
                <FaTimes />
              </button>
            </div>
            <div className="error-content">
              <ul className="error-list">
                {errorLogs.slice(-10).map((error) => (
                  <li key={error.id} className={`log-entry ${error.type}`}>
                    <span className="log-icon">
                      {error.type === 'error' && <FaExclamationTriangle />}
                      {error.type === 'warning' && <FaExclamationTriangle />}
                      {error.type === 'info' && <FaCheckCircle />}
                    </span>
                    <span className="log-message">{error.message}</span>
                    <span className="log-time">
                      {new Date(error.timestamp).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/*Status Section */}
      <div className="status-section">
        <div className="status-indicator">
          <div className={`status-dot ${recording ? (paused ? "paused" : "recording") : "ready"}`}></div>
          <span className="status-text">{status}</span>
          <div className="network-indicator">
            {isOnline ? (
              <FaWifi className="network-icon online" title="Online - Real-time transcription" />
            ) : (
              <MdSignalWifiOff
                className="network-icon offline"
                title="Offline - Audio chunks are being buffered"
              />
            )}
            {retryingConnection && (
              <span className="retry-indicator">Retrying...</span>
            )}
            <SyncStatusIndicator />
          </div>
        </div>
        <div className="timer-display">
          <span className="timer-value">{formatTime(duration)}</span>
        </div>
      </div>

      {/*Tab Selection Section */}
      <div className="tab-selection-section">
        <div className="tab-controls">
          <button
            className="refresh-tabs-btn"
            onClick={refreshTabs}
            disabled={recording}
            title="Refresh available tabs"
          >
            <FaSync />
          </button>
          <select
            className="tab-selector"
            value={selectedTabId || ""}
            onChange={(e) => setSelectedTabId(Number(e.target.value))}
            disabled={recording}
          >
            <option value="">Select a tab to capture audio from...</option>
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.active ? "🔴 " : ""}
                {tab.url?.includes('meet.google.com') ? "📞 " : ""}
                {tab.url?.includes('zoom.us') ? "📞 " : ""}
                {tab.url?.includes('teams.microsoft.com') ? "📞 " : ""}
                {tab.url?.includes('youtube.com') ? "📺 " : ""}
                {tab.title}
              </option>
            ))}
          </select>
        </div>
        {currentTabInfo && (
          <div className="current-tab-info">
            <div className="tab-preview">
              {currentTabInfo.favIconUrl && (
                <img
                  src={currentTabInfo.favIconUrl}
                  alt="Tab icon"
                  className="tab-favicon"
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              )}
              <div className="tab-details">
                <div className="tab-title">{currentTabInfo.title}</div>
                <div className="tab-url">{currentTabInfo.url}</div>
              </div>
              {currentTabInfo.active && (
                <span className="active-tab-badge">Active Tab</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Controls Section */}
      <div className="controls-section">
        <div className="primary-controls">
          <button
            className={`control-btn start-btn ${recording ? "disabled" : ""}`}
            onClick={startRecording}
            disabled={recording || !selectedTabId}
            title={!selectedTabId ? "Please select a tab first" : "Start recording with 30-second chunks and 3-second overlap"}
          >
            <FaPlay className="btn-icon" />
          </button>
          
          <button
            className={`control-btn stop-btn ${!recording ? "disabled" : ""}`}
            onClick={stopRecording}
            disabled={!recording}
            title="Stop recording and process final chunk"
          >
            <FaStop className="btn-icon" />
          </button>
        </div>
        
        <div className="secondary-controls">
          <label className="mic-toggle">
            <input
              type="checkbox"
              checked={includeMic}
              onChange={(e) => handleMicrophoneToggle(e.target.checked)}
              className="mic-checkbox"
              disabled={recording}
            />
            <div
              className={`mic-toggle-ui ${
                micPermissionStatus === "denied" ? "permission-denied" : ""
              } ${includeMic ? "enabled" : ""}`}
            >
              {includeMic ? (
                <FaMicrophone className="mic-icon enabled" />
              ) : (
                <FaMicrophoneSlash className="mic-icon disabled" />
              )}
            </div>
          </label>
        </div>
      </div>

      {/* Live Transcript Section */}
      <div className="transcript-section">
        <div className="section-header">
          <div className="transcript-actions">
            <button
              className="action-btn clear-btn"
              onClick={clearTranscript}
              disabled={!transcriptChunks.length || recording}
              title="Clear transcript and sync queue"
            >
              <FaEraser className="btn-icon" />
            </button>
            <button
              className="action-btn copy-btn"
              onClick={copyTranscript}
              disabled={!transcriptChunks.length}
              title="Copy full transcript to clipboard"
            >
              <FaCopy className="btn-icon" />
            </button>
          </div>
        </div>
        {/* Transcript Container */}
        <div className="transcript-container" ref={transcriptContainerRef}>
          <div className="transcript-content">
            {transcriptChunks.length > 0 ? (
              <div className="transcript-chunks">
                {transcriptChunks.map((chunk, index) => (
                  <div key={index} className={`transcript-chunk ${chunk.source}`}>
                    <div className="chunk-header">
                      {showTimestamps && (
                        <span className="chunk-timestamp">{chunk.timestamp}</span>
                      )}
                      <div className="chunk-source">
                        {getSourceIcon(chunk.source)}
                        <span className="source-label">
                          {chunk.source}
                        </span>
                      </div>
                      {chunk.isLastChunk && (
                        <span className="final-chunk-indicator">Final</span>
                      )}
                    </div>
                    <div className="chunk-text">{chunk.text}</div>
                  </div>
                ))}
                {recording && (
                  <div className="recording-indicator">
                    <div className="pulse-dot"></div>
                    <span>
                      {paused ? "Recording paused..." : "Recording in Progress"}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="transcript-placeholder">
                <div className="placeholder-icon">📝</div>
                <h3>Your transcript will appear here</h3>
                <p>To start Select a tab above and click Play Icon</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Enhanced Export Section */}
      <div className="export-section">
        <div className="export-controls">
          <button
            className="export-btn txt-btn"
            onClick={downloadTxt}
            disabled={!transcriptChunks.length}
            title="Download as text file with timestamps and source labels"
          >
            <FaFileAlt className="btn-icon" />
            <span>TXT</span>
          </button>
          <button
            className="export-btn json-btn"
            onClick={downloadJson}
            disabled={!transcriptChunks.length}
            title="Download as JSON with full metadata, chunks, sync stats, and configuration"
          >
            <FaFileDownload className="btn-icon" />
            <span>JSON</span>
          </button>
        </div>
      </div>
      {/* Microphone Permission Modal */}
      <MicrophonePermissionModal />
    </div>
  );
};

//Exporting the application
export default App;