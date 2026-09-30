import type { QuestionInput, QuestionType } from './types.js';

export type GradeResult = { correct: boolean | null; ratio: number | null; points: number | null; reviewStatus: 'not_needed' | 'pending' };

function norm(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('ru-RU');
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function gradeQuestion(question: QuestionInput, answer: unknown): GradeResult {
  const { type, data, points } = question;
  switch (type) {
    case 'single_choice': {
      const correct = typeof answer === 'string' && answer === String(data.correctOptionId ?? '');
      return { correct, ratio: correct ? 1 : 0, points: correct ? points : 0, reviewStatus: 'not_needed' };
    }
    case 'multiple_choice': {
      const expected = Array.isArray(data.correctOptionIds) ? data.correctOptionIds.map(String).sort() : [];
      const got = Array.isArray(answer) ? answer.map(String).sort() : [];
      const correct = JSON.stringify(expected) === JSON.stringify(got);
      return { correct, ratio: correct ? 1 : 0, points: correct ? points : 0, reviewStatus: 'not_needed' };
    }
    case 'true_false': {
      const correct = typeof answer === 'boolean' && answer === Boolean(data.correct);
      return { correct, ratio: correct ? 1 : 0, points: correct ? points : 0, reviewStatus: 'not_needed' };
    }
    case 'fill_blank': {
      const accepted = Array.isArray(data.accepted) ? data.accepted.map(norm) : [];
      const correct = accepted.includes(norm(answer));
      return { correct, ratio: correct ? 1 : 0, points: correct ? points : 0, reviewStatus: 'not_needed' };
    }
    case 'numeric': {
      const target = num(data.correct);
      const actual = num(answer);
      const tolerance = Math.max(0, num(data.tolerance) ?? 0);
      const correct = target !== null && actual !== null && Math.abs(actual - target) <= tolerance;
      return { correct, ratio: correct ? 1 : 0, points: correct ? points : 0, reviewStatus: 'not_needed' };
    }
    case 'matching': {
      const pairs = Array.isArray(data.pairs) ? data.pairs as any[] : [];
      if (!pairs.length || !answer || typeof answer !== 'object') return { correct: false, ratio: 0, points: 0, reviewStatus: 'not_needed' };
      let hits = 0;
      for (const pair of pairs) if (norm((answer as any)[pair.id]) === norm(pair.right)) hits += 1;
      const ratio = hits / pairs.length;
      return { correct: ratio === 1, ratio, points: Math.round(points * ratio * 100) / 100, reviewStatus: 'not_needed' };
    }
    case 'ordering': {
      const expected = Array.isArray(data.correctOrderIds) ? data.correctOrderIds.map(String) : [];
      const got = Array.isArray(answer) ? answer.map(String) : [];
      if (!expected.length) return { correct: false, ratio: 0, points: 0, reviewStatus: 'not_needed' };
      let hits = 0;
      expected.forEach((value, index) => { if (got[index] === value) hits += 1; });
      const ratio = hits / expected.length;
      return { correct: ratio === 1, ratio, points: Math.round(points * ratio * 100) / 100, reviewStatus: 'not_needed' };
    }
    case 'short_text':
    case 'long_text':
    case 'code':
      return { correct: null, ratio: null, points: null, reviewStatus: 'pending' };
    default:
      return { correct: null, ratio: null, points: null, reviewStatus: 'pending' };
  }
}
