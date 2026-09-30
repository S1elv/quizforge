export type QuestionType = 'single_choice' | 'multiple_choice' | 'true_false' | 'fill_blank' | 'matching' | 'short_text' | 'long_text' | 'ordering' | 'numeric' | 'code';

export type Option = { id: string; text: string };
export type Pair = { id: string; left: string; right: string };
export type OrderItem = { id: string; text: string };

export type Question = {
  id?: string;
  position: number;
  type: QuestionType;
  prompt: string;
  points: number;
  data: Record<string, any>;
};

export type TestSettings = {
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  showScoreOnSubmit: boolean;
  allowLateSubmit: boolean;
  trackFocusEvents: boolean;
  requireStudentName: boolean;
  allowResume: boolean;
  passPercent: number;
};

export type Test = {
  id: string;
  title: string;
  description: string;
  durationSeconds: number;
  settings: TestSettings;
  questions: Question[];
  published: boolean;
  shareCode?: string | null;
  currentVersion: number;
  publishedVersion?: number | null;
};
