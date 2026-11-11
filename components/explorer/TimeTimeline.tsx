"use client";

import clsx from "clsx";
import { Pause, Play } from "lucide-react";

import type { Copy } from "@/lib/ui/i18n";

import { SPEEDS } from "./explorerConstants";

type TimeTimelineProps = {
  t: Copy;
  isPlaying: boolean;
  isLive: boolean;
  timeOffsetHours: number;
  speedIndex: number;
  onTogglePlay: () => void;
  onScrub: (offsetHours: number) => void;
  onGoLive: () => void;
  onSpeedChange: (index: number) => void;
};

export function TimeTimeline({
  t,
  isPlaying,
  isLive,
  timeOffsetHours,
  speedIndex,
  onTogglePlay,
  onScrub,
  onGoLive,
  onSpeedChange
}: TimeTimelineProps) {
  return (
    <div className="timeline">
      <button
        className="icon-button strong"
        type="button"
        onClick={onTogglePlay}
        title={isPlaying ? t.pause : t.play}
      >
        {isPlaying ? <Pause size={19} /> : <Play size={19} />}
      </button>
      <label className="range-label">
        <span>{t.time}</span>
        <input
          type="range"
          min={-24}
          max={24}
          step={1}
          value={timeOffsetHours}
          onChange={(event) => onScrub(Number(event.target.value))}
        />
      </label>
      <button
        className={clsx("text-button", isLive && "toggled")}
        type="button"
        onClick={onGoLive}
        aria-pressed={isLive}
      >
        {t.now}
      </button>
      <select
        value={speedIndex}
        onChange={(event) => onSpeedChange(Number(event.target.value))}
        aria-label={t.speed}
      >
        {SPEEDS.map((speed, index) => (
          <option key={speed} value={index}>
            {speed === 0 ? "0x" : `${speed}x`}
          </option>
        ))}
      </select>
    </div>
  );
}
