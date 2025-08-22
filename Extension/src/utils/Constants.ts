// config.js - This file exports the application's configuration constants.

/**
 * The base URL for the Auditra server API.
 * @type {string}
 */
export const API_BASE = "https://auditra-server.vercel.app";

/**
 * The duration of each audio chunk in milliseconds.
 * This is set to 30 seconds as per the requirements.
 * @type {number}
 */
export const CHUNK_DURATION = 30000;

/**
 * The duration of the overlap between consecutive audio chunks in milliseconds.
 * This ensures smooth transitions and is set to 3 seconds.
 * @type {number}
 */
export const OVERLAP_DURATION = 3000;

/**
 * The maximum number of offline chunks to buffer before discarding old ones.
 * This supports the app's offline capability.
 * @type {number}
 */
export const MAX_OFFLINE_CHUNKS = 100;

/**
 * The interval in milliseconds between retry attempts for failed chunk uploads.
 * This is set to 5 seconds.
 * @type {number}
 */
export const RETRY_INTERVAL = 5000;

/**
 * The maximum number of retry attempts for a single chunk upload.
 * This is set to 3 as per the requirements.
 * @type {number}
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * The number of audio chunks to synchronize with the server simultaneously.
 * This helps manage network load and is set to 5.
 * @type {number}
 */
export const SYNC_BATCH_SIZE = 5;
