export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'true_false'
  | 'fill_blank'
  | 'matching'
  | 'short_text'
  | 'long_text'
  | 'ordering'
  | 'numeric'
  | 'code';

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

export type TestSnapshot = {
  title: string;
  description: string;
  durationSeconds: number;
  settings: TestSettings;
  questions: QuestionInput[];
};

export type QuestionInput = {
  id?: string;
  position: number;
  type: QuestionType;
  prompt: string;
  points: number;
  data: Record<string, unknown>;
};
