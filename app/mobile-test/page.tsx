"use client";

/* eslint-disable @next/next/no-img-element */
import { useMemo, useState } from "react";
import { INTERNAL_TEST_QUESTIONS } from "@/lib/interview";

type TestAnswer = {
  question: string;
  answer: string;
};

export default function MobileTestPage() {
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<TestAnswer[]>([]);

  const progress = useMemo(
    () => Math.round((questionIndex / INTERNAL_TEST_QUESTIONS.length) * 100),
    [questionIndex],
  );

  function submitAnswer() {
    const answer = draft.trim();
    if (!answer) return;

    const nextAnswers = [
      ...answers,
      { question: INTERNAL_TEST_QUESTIONS[questionIndex], answer },
    ];
    setAnswers(nextAnswers);
    setDraft("");

    if (questionIndex === INTERNAL_TEST_QUESTIONS.length - 1) {
      setFinished(true);
      return;
    }
    setQuestionIndex((current) => current + 1);
  }

  function restart() {
    setStarted(false);
    setFinished(false);
    setQuestionIndex(0);
    setDraft("");
    setAnswers([]);
  }

  return (
    <main className="mobile-test-shell">
      <header className="mobile-test-header">
        <div className="mobile-test-brand">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>OFFICIAL SELECTION PORTAL</small></span>
        </div>
        <span className="mobile-test-badge">選考対象外</span>
      </header>

      {!started && (
        <section className="mobile-test-intro">
          <div className="mobile-test-visual">
            <img src="/interviewer-mogi.jpg" alt="TOKYO DOGS オンライン採用担当者 茂木" />
            <span>オンライン一次面接ポータル確認</span>
          </div>
          <p className="eyebrow">TOKYO DOGS / PORTAL PREVIEW</p>
          <h1>オンライン一次面接の<br />画面確認</h1>
          <p className="mobile-test-lead">
            選考対象外の接続確認です。{INTERNAL_TEST_QUESTIONS.length}つの質問に文字で回答し、公式選考ポータルの表示と操作を確認します。
          </p>
          <div className="mobile-test-safety">
            <strong>この確認内容は保存しません</strong>
            <span>録画・音声接続・採用評価は行いません。氏名や連絡先は入力しないでください。</span>
          </div>
          <button className="mobile-test-primary" onClick={() => setStarted(true)}>
            接続確認をはじめる <span>→</span>
          </button>
        </section>
      )}

      {started && !finished && (
        <section className="mobile-test-interview">
          <div className="mobile-test-progress-copy">
            <span>質問 {questionIndex + 1} / {INTERNAL_TEST_QUESTIONS.length}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="mobile-test-progress" aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </div>

          <div className="mobile-test-conversation" aria-live="polite">
            <div className="mobile-test-guide">
              <img src="/interviewer-mogi.jpg" alt="" />
              <div><span>ONLINE RECRUITER</span><strong>オンライン採用担当者 茂木</strong></div>
            </div>

            {answers.slice(-1).map((item) => (
              <div className="mobile-test-previous" key={`${item.question}-${item.answer}`}>
                <small>前の回答</small>
                <p>{item.answer}</p>
              </div>
            ))}

            <div className="mobile-test-question">
              <span>質問</span>
              <p>{INTERNAL_TEST_QUESTIONS[questionIndex]}</p>
            </div>
          </div>

          <label className="mobile-test-answer" htmlFor="mobile-test-answer">
            <span>回答を入力</span>
            <textarea
              id="mobile-test-answer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="ここに回答を入力してください"
              rows={5}
              enterKeyHint="done"
            />
          </label>
          <button className="mobile-test-primary" disabled={!draft.trim()} onClick={submitAnswer}>
            {questionIndex === INTERNAL_TEST_QUESTIONS.length - 1 ? "確認を完了" : "回答して次へ"} <span>→</span>
          </button>
          <p className="mobile-test-footnote">入力内容はこの画面内だけで使い、サーバーへ送信しません。</p>
        </section>
      )}

      {finished && (
        <section className="mobile-test-complete">
          <img src="/interviewer-mogi.jpg" alt="" />
          <p className="eyebrow">PORTAL CHECK COMPLETE</p>
          <h1>画面確認が<br />完了しました。</h1>
          <p>{answers.length}問すべてに回答できました。入力内容は保存・送信されていません。</p>
          <div className="mobile-test-complete-card">
            <span>確認できたこと</span>
            <strong>表示・文字入力・画面遷移</strong>
            <small>録画・音声・採用評価は行っていません</small>
          </div>
          <button className="mobile-test-primary" onClick={restart}>もう一度試す</button>
        </section>
      )}

      <footer className="mobile-test-footer">TOKYO DOGS / OFFICIAL RECRUITMENT / CANDIDATE SELECTION PORTAL</footer>
    </main>
  );
}
