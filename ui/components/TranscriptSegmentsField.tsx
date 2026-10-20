import React from 'react';
import './TranscriptSegmentsField.css';

export interface TranscriptSegmentDisplay {
  key: string;
  speaker: string | null;
  startTime: number | null;
  endTime: number | null;
  text: string;
}

const TRANSCRIPT_SEGMENT_KEYS = ['transcription_segments', 'transcript_segments'];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const getStringValue = (value: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return null;
};

const getNumberValue = (value: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
};

const formatTranscriptTime = (seconds: number | null): string => {
  if (seconds === null) {
    return 'unknown';
  }
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const formatSpeakerLabel = (speaker: string | null): string => {
  if (!speaker) {
    return 'Speaker unknown';
  }
  return /^speaker\b/i.test(speaker) ? speaker : `Speaker ${speaker}`;
};

export const getTranscriptSegmentsForDisplay = (
  fieldKey: string,
  value: unknown
): TranscriptSegmentDisplay[] | null => {
  const normalizedFieldKey = fieldKey.toLowerCase();
  const isTranscriptSegmentsField = TRANSCRIPT_SEGMENT_KEYS.some((key) => normalizedFieldKey.includes(key));
  if (!isTranscriptSegmentsField || !Array.isArray(value)) {
    return null;
  }

  const segments = value
    .map((item, index): TranscriptSegmentDisplay | null => {
      if (!isRecord(item)) {
        return null;
      }

      const text = getStringValue(item, ['text', 'transcript', 'transcription']);
      if (!text) {
        return null;
      }

      const speaker = getStringValue(item, ['speaker_tag', 'speaker', 'speaker_id']);
      const startTime = getNumberValue(item, ['start_time', 'start', 'startTime']);
      const endTime = getNumberValue(item, ['end_time', 'end', 'endTime']);

      return {
        key: `${fieldKey}-${index}-${startTime ?? 'start'}-${endTime ?? 'end'}`,
        speaker,
        startTime,
        endTime,
        text,
      };
    })
    .filter((segment): segment is TranscriptSegmentDisplay => segment !== null);

  return segments.length > 0 ? segments : null;
};

interface TranscriptSegmentsFieldProps {
  segments: TranscriptSegmentDisplay[];
}

const TranscriptSegmentsField: React.FC<TranscriptSegmentsFieldProps> = ({ segments }) => (
  <div className="transcription-segments-container">
    <div className="transcription-segments-list">
      {segments.map((segment) => (
        <article key={segment.key} className="transcription-segment-item">
          <div className="transcription-segment-header">
            <span className="transcription-speaker">{formatSpeakerLabel(segment.speaker)}</span>
            <span className="transcription-time">
              {formatTranscriptTime(segment.startTime)} - {formatTranscriptTime(segment.endTime)}
            </span>
          </div>
          <p className="transcription-text">{segment.text}</p>
        </article>
      ))}
    </div>
  </div>
);

export default TranscriptSegmentsField;
