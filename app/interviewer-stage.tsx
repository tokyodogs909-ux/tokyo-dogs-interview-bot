"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";

const SPEAKING_CUTS = [2, 3, 6, 7, 8, 10];
const LISTENING_CUTS = [1, 4, 5, 9];
const ALL_CUTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function InterviewerStage({ speaking }: { speaking: boolean }) {
  const pool = speaking ? SPEAKING_CUTS : LISTENING_CUTS;
  const [step, setStep] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => setStep((current) => current + 1), 3_200);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  const activeCut = pool[step % pool.length];

  return (
    <div className={`interviewer-stage ${speaking ? "speaking" : "listening"}`} aria-label="オンライン採用担当者 茂木の案内イメージ">
      {ALL_CUTS.map((cut) => (
        <img
          key={cut}
          src={`/interviewer-mogi-${cut}.jpg`}
          alt=""
          aria-hidden="true"
          decoding="async"
          className={cut === activeCut ? "on" : ""}
        />
      ))}
      <span className="interviewer-stage-badge" aria-hidden="true">
        <i />
        {speaking ? "音声案内中" : "回答を確認中"}
      </span>
      <span className="interviewer-stage-name">オンライン採用担当者 茂木｜案内イメージ</span>
    </div>
  );
}
