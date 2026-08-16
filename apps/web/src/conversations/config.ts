import { RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES } from "@capstone/protocol";

export const DRAFT_AUTOSAVE_DELAY_MS = 600;
export const SEARCH_DEBOUNCE_DELAY_MS = 250;
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "capstone-chat.sidebar-collapsed.v1";
export const STREAM_MAX_LINE_BYTES = 65_536;
export const STREAM_MAX_ACCUMULATOR_BYTES = RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES;
export const RESPONSE_STATE_POLL_INTERVAL_MS = 2_000;
export const MOBILE_SHELL_MEDIA_QUERY = "(max-width: 48rem)";
export const PREFERS_REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";
export const CONVERSATION_FOLLOW_THRESHOLD_PX = 96;
export const SEARCH_MATCH_HOLD_MS = 1_560;
export const SEARCH_MATCH_FADE_MS = 520;
export const REATTACH_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
export const REATTACH_JITTER_RATIO = 0.2;
export const REATTACH_REQUEST_TIMEOUT_MS = 15_000;
