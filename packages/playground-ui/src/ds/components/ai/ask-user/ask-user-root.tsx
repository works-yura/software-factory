import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { AskUserContext } from './ask-user-context';
import { AskUserContainer } from './ask-user-layout';
import type { AskUserAnswer, AskUserSelectionMode } from './ask-user-types';

interface AskUserStateProps {
  selectionMode?: AskUserSelectionMode;
  disabled?: boolean;
  /** Options chosen before the person touches the question, e.g. a recommended answer. */
  defaultSelectedOptionLabels?: string[];
}

export interface AskUserRootProps extends AskUserStateProps, Omit<ComponentProps<typeof AskUserContainer>, 'onSubmit'> {
  onSubmit: (answer: AskUserAnswer) => void;
}

/**
 * One question's answer state without its card, for a form that asks several questions at once:
 * choosing an option never submits, and the current answer is reported as it changes.
 */
export interface AskUserProviderProps extends AskUserStateProps {
  /** The current answer, or undefined while the question has none. */
  onAnswerChange: (answer: AskUserAnswer | undefined) => void;
  children: ReactNode;
}

interface AskUserAnswerDraft {
  answerText: string;
  selectedOptionLabels: string[];
  selectionMode: AskUserSelectionMode;
  isCustomAnswerSelected: boolean;
}

function getAnswerToSubmit({
  answerText,
  selectedOptionLabels,
  selectionMode,
  isCustomAnswerSelected,
}: AskUserAnswerDraft): AskUserAnswer | undefined {
  const trimmedAnswerText = answerText.trim();
  if (isCustomAnswerSelected && !trimmedAnswerText) return undefined;
  if (selectionMode === 'single_select') {
    // Suggested single-select answers already submit when selected.
    if (!isCustomAnswerSelected && selectedOptionLabels.length > 0) return undefined;
    return trimmedAnswerText || undefined;
  }

  const answerLabels = isCustomAnswerSelected ? [...selectedOptionLabels, trimmedAnswerText] : selectedOptionLabels;
  return answerLabels.length > 0 ? answerLabels : undefined;
}

/** What the question holds right now, whether or not anything was submitted. */
function getCurrentAnswer({
  answerText,
  selectedOptionLabels,
  selectionMode,
  isCustomAnswerSelected,
}: AskUserAnswerDraft): AskUserAnswer | undefined {
  if (selectionMode === 'multi_select') {
    return getAnswerToSubmit({ answerText, selectedOptionLabels, selectionMode, isCustomAnswerSelected });
  }
  const trimmedAnswerText = answerText.trim();
  if (isCustomAnswerSelected) return trimmedAnswerText || undefined;
  return selectedOptionLabels[0] ?? (trimmedAnswerText || undefined);
}

function toggleSelectedOptionLabel(selectedOptionLabels: string[], optionLabel: string): string[] {
  if (selectedOptionLabels.includes(optionLabel)) {
    return selectedOptionLabels.filter(selectedLabel => selectedLabel !== optionLabel);
  }
  return [...selectedOptionLabels, optionLabel];
}

interface AskUserStateOptions extends AskUserStateProps {
  /** Submits the answer; absent when the question is one of several and a shared button sends them all. */
  onSubmit?: (answer: AskUserAnswer) => void;
}

function useAskUserState({
  selectionMode = 'single_select',
  disabled = false,
  defaultSelectedOptionLabels = [],
  onSubmit,
}: AskUserStateOptions) {
  const questionId = useId();
  const [answerText, setAnswerText] = useState('');
  const [selectedOptionLabels, setSelectedOptionLabels] = useState<string[]>(defaultSelectedOptionLabels);
  const [isCustomAnswerSelected, setIsCustomAnswerSelected] = useState(false);
  const draft = { answerText, selectedOptionLabels, selectionMode, isCustomAnswerSelected };
  const answerToSubmit = onSubmit ? getAnswerToSubmit(draft) : getCurrentAnswer(draft);
  const canSubmitAnswer = !disabled && answerToSubmit !== undefined;

  const selectOption = (optionLabel: string) => {
    if (disabled) return;
    if (selectionMode === 'multi_select') {
      setSelectedOptionLabels(currentLabels => toggleSelectedOptionLabel(currentLabels, optionLabel));
      return;
    }
    setIsCustomAnswerSelected(false);
    setSelectedOptionLabels([optionLabel]);
    onSubmit?.(optionLabel);
  };

  const setCustomAnswerSelected = (selected: boolean) => {
    if (disabled) return;
    setIsCustomAnswerSelected(selected);
    if (selected && selectionMode === 'single_select') setSelectedOptionLabels([]);
  };

  const changeAnswerText = (text: string) => {
    if (!disabled) setAnswerText(text);
  };

  const unselectEmptyCustomAnswer = () => {
    if (!disabled && !answerText.trim()) setIsCustomAnswerSelected(false);
  };

  const submitAnswer = () => {
    if (disabled || answerToSubmit === undefined) return;
    onSubmit?.(answerToSubmit);
  };

  const context = {
    questionId,
    selectionMode,
    disabled,
    answerText,
    selectedOptionLabels,
    isCustomAnswerSelected,
    canSubmitAnswer,
    selectOption,
    setCustomAnswerSelected,
    changeAnswerText,
    unselectEmptyCustomAnswer,
    submitAnswer,
  };
  return { context, currentAnswer: getCurrentAnswer(draft) };
}

export function AskUserRoot({
  selectionMode,
  disabled,
  defaultSelectedOptionLabels,
  onSubmit,
  children,
  ...props
}: AskUserRootProps) {
  const { context } = useAskUserState({ selectionMode, disabled, defaultSelectedOptionLabels, onSubmit });

  return (
    <AskUserContext.Provider value={context}>
      <AskUserContainer role="group" aria-labelledby={context.questionId} {...props}>
        {children}
      </AskUserContainer>
    </AskUserContext.Provider>
  );
}

export function AskUserProvider({ onAnswerChange, children, ...state }: AskUserProviderProps) {
  const { context, currentAnswer } = useAskUserState(state);
  const reported = useRef<string | undefined>(undefined);
  const key = JSON.stringify(currentAnswer ?? null);
  useEffect(() => {
    if (reported.current === key) return;
    reported.current = key;
    onAnswerChange(currentAnswer);
  });

  return <AskUserContext.Provider value={context}>{children}</AskUserContext.Provider>;
}
