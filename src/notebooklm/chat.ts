/**
 * NotebookLM chat extraction with streaming-stability detection.
 *
 * Replaces the legacy `waitForLatestAnswer()` (issue #43). Old logic gated on
 * `div.thinking-message`, which Google removed; calls timed out even though
 * the answer was visible. New logic only relies on the answer container itself
 * and treats text as final once it has been *stable* across N consecutive
 * polls (default 3). That makes the wait robust to UI churn and Material-icon
 * leaks (`more_vert`, `more_horiz`, …) which would otherwise destabilise the
 * extracted text.
 *
 * The new turn is identified structurally — the chat turns that exist after
 * the ones counted before submitting, preferring the one whose question
 * matches — never by comparing answer texts, so an earlier answer is never
 * returned for a new question.
 *
 * All DOM reads go through a single `page.evaluate`: on current Gemini
 * Notebook builds, patchright locator reads (`innerText`, `textContent`,
 * `evaluate`) on the answer node time out even though the node exists.
 *
 * Companion fixes:
 * - issue #14 / #27 — timeout is fully configurable per call
 * - issue #16    — bounded polls + sleep fallback to defuse zombie pages
 * - issue #28    — sanitisation strips UI-control labels before delivery
 */

import type { Page } from "patchright";
import { Selectors, joinAlt } from "./selectors.js";
import { isRecoverable, pageIsAlive, safeSleep } from "../browser/watchdog.js";

/**
 * Loading-state phrases NotebookLM streams into the answer container before
 * the real response arrives. The stability detector would otherwise lock
 * onto these (they're "stable" while Gemini still thinks). Coverage spans
 * the eight major NotebookLM locales (EN, DE, FR, ES, PT, IT, NL, JA).
 */
const PLACEHOLDER_SNIPPETS = [
  // English
  "answer is being created",
  "answer is being generated",
  "creating answer",
  "generating answer",
  "getting the context",
  "getting the gist",
  "loading",
  "please wait",
  "looking for clues",
  "reading full chapters",
  "examining the specifics",
  "checking the scope",
  "opening your notes",
  "analyzing your files",
  "searching your docs",
  "scanning sources",
  "reviewing content",
  "processing request",
  "parsing the data",
  "gathering the facts",
  "thinking",
  "searching",
  // German
  "antwort wird erstellt",
  "antwort wird generiert",
  "wird erstellt",
  "wird generiert",
  "lädt",
  "wird geladen",
  "bitte warten",
  "quellen werden gescannt",
  "kontext wird abgerufen",
  "denke nach",
  // French
  "analyse en cours",
  "génération en cours",
  "réponse en cours",
  "chargement en cours",
  "veuillez patienter",
  "recherche en cours",
  // Spanish
  "generando respuesta",
  "creando respuesta",
  "cargando",
  "espere por favor",
  "buscando",
  "analizando",
  // Italian
  "generazione della risposta",
  "creazione della risposta",
  "caricamento",
  "attendere",
  "ricerca in corso",
  "analisi in corso",
  // Portuguese
  "gerando resposta",
  "criando resposta",
  "carregando",
  "por favor aguarde",
  "procurando",
  "analisando",
  // Dutch
  "antwoord wordt gegenereerd",
  "antwoord wordt gemaakt",
  "laden",
  "even geduld",
  "zoeken",
  "analyseren",
  // Japanese
  "回答を生成しています",
  "読み込み中",
  "お待ちください",
  "検索中",
  "分析中",
];

const ERROR_SNIPPETS = [
  // English
  "the system could not respond",
  "the system failed",
  "an error occurred",
  "try again later",
  // German
  "das system konnte keine antwort erstellen",
  "das system konnte nicht antworten",
  "es ist ein fehler aufgetreten",
  "versuche es später erneut",
  "versuchen sie es später erneut",
  // French
  "le système n'a pas pu répondre",
  "le système n'a pas réussi",
  "une erreur est survenue",
  "réessayez plus tard",
  // Spanish
  "el sistema no pudo responder",
  "ha ocurrido un error",
  "vuelve a intentarlo más tarde",
  "inténtalo de nuevo más tarde",
  // Italian
  "il sistema non è riuscito a rispondere",
  "si è verificato un errore",
  "riprova più tardi",
  // Portuguese
  "o sistema não pôde responder",
  "ocorreu um erro",
  "tente novamente mais tarde",
  // Dutch
  "het systeem kon niet reageren",
  "er is een fout opgetreden",
  "probeer het later opnieuw",
  // Japanese
  "システムが応答できませんでした",
  "エラーが発生しました",
  "後でもう一度お試しください",
];

const RATE_LIMIT_MESSAGES = [
  // English
  "daily discussion limit",
  "daily limit reached",
  "query limit reached",
  "rate limit exceeded",
  // German
  "tägliches diskussionslimit",
  "tageslimit erreicht",
  "ratenlimit überschritten",
  // French
  "vous avez atteint la limite quotidienne",
  "limite quotidienne de discussions",
  "limite quotidienne atteinte",
  // Spanish
  "límite diario alcanzado",
  "has alcanzado el límite diario",
  // Italian
  "limite giornaliero raggiunto",
  "hai raggiunto il limite giornaliero",
  // Portuguese
  "limite diário atingido",
  "você atingiu o limite diário",
  // Dutch
  "daglimiet bereikt",
  // Japanese
  "1日あたりの上限に達しました",
];

function isPlaceholder(text: string): boolean {
  const lower = text.toLowerCase();
  if (PLACEHOLDER_SNIPPETS.some((s) => lower.includes(s))) return true;
  // Short text ending with "..." is almost certainly a loading indicator;
  // real responses run well past 50 chars.
  if (text.length < 50 && text.trim().endsWith("...")) return true;
  return false;
}

function isErrorMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_SNIPPETS.some((s) => lower.includes(s));
}

function isRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_MESSAGES.some((s) => lower.includes(s));
}

export interface AskOptions {
  /** The question text — used to pick the matching turn and skip echoes. */
  question?: string;
  /** Hard ceiling on the wait. Default 600 000 ms (10 min) — overridable per call. */
  timeoutMs?: number;
  /** Poll cadence. Default 750 ms. Lower values increase load without much benefit. */
  pollIntervalMs?: number;
  /** Chat turns present *before* the question was submitted (`countChatTurns`). */
  priorTurns?: number;
  /** How many consecutive identical polls count as "answer settled". Default 3. */
  stablePolls?: number;
}

/** One question/answer exchange as rendered in the chat panel. */
export interface ChatTurn {
  question: string | null;
  answer: string | null;
}

/**
 * Read every chat turn in DOM order with one `page.evaluate`. Falls back to
 * bare answer containers (no question) on layouts without turn wrappers.
 *
 * Answers are serialised from a detached clone rather than `innerText`:
 * citation markers are flex buttons, so `innerText` splits them onto lines of
 * their own ("…datos\n1\n."). The clone drops the "Thoughts" block, turns each
 * marker into `[n]` (the form `citations.ts` formats) and keeps block breaks.
 */
export async function readChatTurns(page: Page): Promise<ChatTurn[]> {
  return page.evaluate(
    ({ turn, questionText, answerText, thinking, citation }) => {
      const answerOf = (el: Element): string => {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(thinking).forEach((n) => n.remove());
        clone
          .querySelectorAll(citation)
          .forEach((n) => n.replaceWith(`[${(n.textContent ?? "").trim()}]`));
        clone.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
        clone.querySelectorAll("ul, ol").forEach((list) => {
          list.querySelectorAll("li").forEach((li, i) => {
            if (li.closest("ul, ol") === list)
              li.prepend(list.tagName === "OL" ? `${i + 1}. ` : "- ");
          });
        });
        clone
          .querySelectorAll("div, p, li, h1, h2, h3, h4, h5, h6, tr")
          .forEach((n) => n.append("\n"));
        return clone.textContent ?? "";
      };
      const turns = [...document.querySelectorAll(turn)];
      if (turns.length > 0) {
        return turns.map((t) => {
          const q = t.querySelector(questionText) as HTMLElement | null;
          const a = t.querySelector(answerText);
          return { question: q?.innerText ?? null, answer: a ? answerOf(a) : null };
        });
      }
      return [...document.querySelectorAll(answerText)].map((el) => ({
        question: null,
        answer: answerOf(el),
      }));
    },
    {
      turn: Selectors.chat.turn,
      questionText: Selectors.chat.questionText,
      answerText: Selectors.chat.answerText,
      thinking: Selectors.chat.thinking,
      citation: joinAlt(Selectors.citations.button),
    }
  );
}

/**
 * Count the chat turns *before* a new question is submitted. Pass the result
 * into `waitForStableAnswer({ priorTurns })` so only newer turns are read.
 */
export async function countChatTurns(page: Page): Promise<number> {
  return readChatTurns(page)
    .then((turns) => turns.length)
    .catch(() => 0);
}

/**
 * How long to wait for a new turn whose question matches before accepting
 * the newest new turn regardless (covers UIs that rewrite the question).
 */
const QUESTION_MATCH_GRACE_MS = 10_000;

/**
 * Wait for the answer to the question just submitted to appear and stabilise.
 *
 * Returns the sanitised final text, or `null` on timeout. The function never
 * throws on UI hiccups — failure surfaces as `null` so the caller can decide
 * how to recover (retry vs. report error to the user).
 */
export async function waitForStableAnswer(
  page: Page,
  options: AskOptions = {}
): Promise<string | null> {
  const {
    question = "",
    timeoutMs = 600_000,
    pollIntervalMs = 750,
    priorTurns = 0,
    stablePolls = 3,
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const echoLower = question.trim().toLowerCase();
  // Hard ceiling on poll iterations defends against pathological
  // pollIntervalMs values combined with zombie-page sleep returns (issue #16).
  const maxPolls = Math.max(8, Math.ceil(timeoutMs / Math.max(50, pollIntervalMs)) + 4);

  let lastSeen: string | null = null;
  let stableStreak = 0;
  let pollCount = 0;

  while (Date.now() < deadline && pollCount < maxPolls) {
    pollCount++;

    // Every 10th poll we make sure the renderer still answers — bounded so a
    // wedged tab can't keep us spinning until the deadline (issue #16).
    if (pollCount % 10 === 0 && !(await pageIsAlive(page))) {
      throw new Error("Browser page unresponsive: health check timed out");
    }

    let candidate: string | null = null;
    try {
      const turns = await readChatTurns(page);
      const turn = pickNewTurn(turns, priorTurns, question, Date.now() - startedAt);
      const cleaned = turn?.answer ? sanitizeAnswer(turn.answer) : "";
      candidate = cleaned.length > 0 ? cleaned : null;
    } catch (err) {
      if (isRecoverable(err)) throw err;
      // Non-fatal extraction blip — try again next tick.
    }

    if (candidate) {
      const isEcho = candidate.toLowerCase() === echoLower;

      if (!isEcho) {
        // Loading placeholders ("Parsing the data…", "Thinking…", …) are
        // stable while Gemini is still working — the old code locked on to
        // them and returned them as the final answer. Filter them out.
        if (isPlaceholder(candidate)) {
          stableStreak = 0;
          lastSeen = null;
          await safeSleep(page, Math.min(pollIntervalMs, 400));
          continue;
        }

        // Hard errors and rate-limit messages can be returned immediately —
        // there is no "stable" follow-up text coming.
        if (isErrorMessage(candidate) || isRateLimitText(candidate)) {
          return candidate;
        }

        if (candidate === lastSeen) {
          stableStreak++;
          if (stableStreak >= stablePolls) {
            return candidate;
          }
        } else {
          lastSeen = candidate;
          stableStreak = 1;
        }
      }
    }

    await safeSleep(page, pollIntervalMs);
  }

  return null;
}

/**
 * Pick the turn that answers `question` among the turns added after
 * `priorTurns`: the newest one whose question matches, or — once the grace
 * period is over — simply the newest one.
 */
export function pickNewTurn(
  turns: ChatTurn[],
  priorTurns: number,
  question: string,
  elapsedMs: number
): ChatTurn | null {
  const fresh = turns.slice(priorTurns);
  if (fresh.length === 0) return null;

  const wanted = normalizeQuestion(question);
  if (wanted) {
    for (let i = fresh.length - 1; i >= 0; i--) {
      const asked = fresh[i].question;
      if (asked !== null && normalizeQuestion(asked) === wanted) return fresh[i];
    }
    if (elapsedMs < QUESTION_MATCH_GRACE_MS) return null;
  }
  return fresh[fresh.length - 1];
}

function normalizeQuestion(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Strip Material-icon labels (`more_vert`, `more_horiz`, …) and orphaned
 * citation markers that NotebookLM occasionally leaks into `innerText`.
 * Only isolated lines are removed — never inline content — so legitimate
 * answer prose with the same words ("more horizontal") is not touched.
 */
export function sanitizeAnswer(text: string): string {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (Selectors.uiControlLabels.has(line)) continue;

    // Drop lone digits or punctuation flanking a UI-control label
    // (typical citation-marker leak: ["1", "more_vert"]).
    const next = lines[i + 1] ?? "";
    const prev = lines[i - 1] ?? "";
    const nextIsControl = Selectors.uiControlLabels.has(next);
    const prevIsControl = Selectors.uiControlLabels.has(prev);
    if (/^\d+$/.test(line) && nextIsControl) continue;
    if (/^[.,;:!?]+$/.test(line) && (nextIsControl || prevIsControl)) continue;

    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}
