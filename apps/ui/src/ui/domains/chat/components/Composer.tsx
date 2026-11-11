import type { MastraDBMessage } from '@mastra/core/agent-controller';
import {
  ComposerAnnotations,
  formatAnnotatedMessage,
  useChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import type { ChatAnnotation } from '@mastra/playground-ui/components/ai/annotations';
import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import {
  Composer as ComposerRoot,
  ComposerActions,
  ComposerBox,
  ComposerHeader,
  ComposerInput,
  ComposerRing,
  ComposerSuggestions,
  useComposerCommands,
} from '@mastra/playground-ui/components/Composer';
import type { ComposerInputProps } from '@mastra/playground-ui/components/Composer';
import { useOptionalMessageScroller } from '@mastra/playground-ui/components/MessageScroller';
import { cn } from '@mastra/playground-ui/utils/cn';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate, useParams } from 'react-router';

import { INITIAL_THREAD_MESSAGE_LIMIT, queryKeys } from '../../../../api/keys';
import { useChatCommands } from '../context/ChatCommandsProvider';
import { useChatConnection } from '../context/useChatConnection';
import { useChatModels } from '../context/useChatModels';
import { useChatSessionContext } from '../context/useChatSessionContext';
import { useChatTranscript } from '../context/useChatTranscript';
import type { PendingImage } from '../context/ComposerImagesContext';
import {
  useAbortAgentControllerMutation,
  useSendAgentControllerMessageMutation,
} from '../../../../hooks/useAgentControllerRunMutations';
import { useCreateAgentControllerThreadMutation } from '../../../../hooks/useAgentControllerThreadMutations';
import { usePreparingThreadId } from '../hooks/usePreparingThreadId';
import { useComposerConnectionNotice } from '../hooks/useComposerConnectionNotice';
import { useComposerAttachmentUpload, withAttachmentLines } from '../hooks/useComposerAttachmentUpload';
import { useCreateUserSessionFromDraft } from '../hooks/useCreateUserSessionFromDraft';
import { clearPendingHandoff } from '../hooks/useHandoffPrompt';
import { usePendingPlanFeedback } from '../hooks/usePendingPlanFeedback';
import { commandRequiresReadySession, isSlashCommand } from '../services/commands';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { FACTORY_REF_EVENT, FACTORY_REF_MIME, readDraggedRef, sameRef, serializeRefs, withRef } from '../services/factoryRefs';
import type { FactoryRef } from '../services/factoryRefs';
import { StatusLine } from './StatusLine';
import { useComposerProviderModel } from './modelPicker/useComposerProviderModel';
import './modelPicker/ultrathink.css';
import { ComposerConnectionNotice } from './ComposerConnectionNotice';
import { ComposerFileAttachments } from './ComposerFileAttachments';
import { ComposerImageAttachments } from './ComposerImageAttachments';
import { ComposerPrimaryAction } from './ComposerPrimaryAction';
import { ComposerFactoryRefs } from './FactoryRefChips';
import { useComposerImages } from './useComposerImages';
import { useInitializingPlaceholder } from './useInitializingPlaceholder';

type ComposerProps = Pick<ComposerInputProps, 'variant'>;

export function Composer({ variant = 'inline' }: ComposerProps) {
  const { t } = useTranslation('chat');
  const { sessionId, sessionEnabled, baseUrl, factorySessionState, claudeCode, harness } = useChatSessionContext();
  const { factoryId } = useParams<{ factoryId: string }>();
  const onDraftComposer = useMatch('/factories/:factoryId/new') !== null;
  const onUserDraft = useMatch('/factories/:factoryId/user/new/:draftSessionId') !== null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { status } = useChatConnection();
  const connectionNotice = useComposerConnectionNotice(status);
  const connectionLost = connectionNotice.open && connectionNotice.notice !== 'reconnected';
  const { busy, phase, localUser, failLocalUser, reset, clearPending, pushNotice } = useChatTranscript();
  const chatPreparing = phase === 'initializing';
  const scroller = useOptionalMessageScroller();
  const { isLoading: modelLoading, error: modelError } = useChatModels();
  // The Ultrathink cue: a prompt that asks for it frames the composer.
  const { composerProviderState } = useComposerProviderModel();
  const {
    commands,
    composerDraft: draft,
    composerPreview: preview,
    composerInputRef: inputRef,
    setComposerDraft,
    runComposerCommand,
  } = useChatCommands();

  const hookArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  };
  const { annotations, takeAnnotations, restoreAnnotations, sendRequests } = useChatAnnotations();
  const createThreadMutation = useCreateAgentControllerThreadMutation(hookArgs);
  const sendMutation = useSendAgentControllerMessageMutation(hookArgs);
  const abortMutation = useAbortAgentControllerMutation(hookArgs);
  const planFeedback = usePendingPlanFeedback();

  const preparingThreadId = usePreparingThreadId();
  const liveRun = phase === 'working' && !preparingThreadId && sessionEnabled;
  const createSessionFromDraft = useCreateUserSessionFromDraft();
  const blocked = onUserDraft ? !factorySessionState : status !== 'ready' && !preparingThreadId;
  // A draft send waits for a model still loading, so only a model that failed to load holds it back.
  // A Claude Code draft runs on its Factory's Claude model: the Mastra model list has no say.
  const draftModelFailed = onUserDraft && !claudeCode && modelError !== undefined;
  const [heldDraftText, setHeldDraftText] = useState<string>();
  const startingDraft = heldDraftText !== undefined;
  // A harness that takes no images (Claude Code here) gets them as attached files instead. A draft has no session
  // to attach files to yet, so it takes images only, and none on such a harness.
  const imagesToModel = harness?.supports.imageAttachments !== false;
  const acceptFiles = !onUserDraft;
  const attachDisabled =
    blocked || chatPreparing || planFeedback.pending || startingDraft || (!acceptFiles && !imagesToModel);
  const { images, setImages, files, setFiles, fileInputRef, removeImage, removeFile, onPaste, onDrop, onFileInputChange } =
    useComposerImages({ disabled: chatPreparing || planFeedback.pending || startingDraft, acceptFiles, imagesToModel });
  const uploadAttachments = useComposerAttachmentUpload(sessionId);
  // Sessions and cards dragged in from the sidebar (or added from a row's menu), sent as a `factory-refs` block.
  const [refs, setRefs] = useState<FactoryRef[]>([]);
  const addRef = (ref: FactoryRef) => setRefs(current => withRef(current, ref));
  const removeRef = (ref: FactoryRef) => setRefs(current => current.filter(existing => !sameRef(existing, ref)));
  const onRefAdded = useEffectEvent((event: Event) => {
    const ref = (event as CustomEvent<FactoryRef>).detail;
    if (!ref) return;
    event.preventDefault();
    addRef(ref);
    inputRef.current?.focus();
  });
  useEffect(() => {
    const listener = (event: Event) => onRefAdded(event);
    window.addEventListener(FACTORY_REF_EVENT, listener);
    return () => window.removeEventListener(FACTORY_REF_EVENT, listener);
  }, []);
  // A dragged row is a reference; anything else (image files) goes to the image drop.
  const onComposerDrop = (event: DragEvent<HTMLFormElement>) => {
    const ref = readDraggedRef(event.dataTransfer);
    if (!ref) {
      onDrop(event);
      return;
    }
    event.preventDefault();
    addRef(ref);
  };
  const onComposerDragOver = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (event.dataTransfer?.types?.includes(FACTORY_REF_MIME)) event.dataTransfer.dropEffect = 'copy';
  };
  const composerDisabled = startingDraft || blocked || planFeedback.isSubmitting;
  const sendDisabled = composerDisabled || draftModelFailed || chatPreparing || planFeedback.loading;
  // A starter card previews its prompt in the composer; sending sends what is shown.
  const shownText = preview?.text ?? draft;
  const hasSubmittableDraft =
    shownText.trim().length > 0 ||
    annotations.length > 0 ||
    refs.length > 0 ||
    ((images.length > 0 || files.length > 0) && !planFeedback.pending);
  const textareaDisabled = composerDisabled && !chatPreparing;
  const initializingPlaceholder = useInitializingPlaceholder(chatPreparing, draft.length === 0);
  const normalPlaceholder = planFeedback.pending
    ? t('composer.planFeedbackPlaceholder')
    : liveRun
      ? t('composer.steerPlaceholder')
      : claudeCode
        ? t('claudeCode.placeholder')
        : t('composer.placeholder');
  const placeholder = initializingPlaceholder ?? normalPlaceholder;
  const sendTitle = chatPreparing
    ? t('composer.initializingSession')
    : startingDraft
      ? t('composer.startingSession')
      : undefined;

  const updateDraft = setComposerDraft;

  const createThread = async () => {
    const thread = await createThreadMutation.mutateAsync(undefined);
    reset(thread.id);
    return thread.id;
  };

  const seedThreadMessageCache = (threadId: string, text: string, files: PendingImage[]) => {
    const message: MastraDBMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: 'text', text },
          ...files.map(f => ({ type: 'file' as const, data: f.data, mimeType: f.mediaType })),
        ],
      },
    };
    queryClient.setQueryData(
      queryKeys.agentControllerThreadMessages(AGENT_CONTROLLER_ID, sessionId, threadId, INITIAL_THREAD_MESSAGE_LIMIT),
      [message],
    );
  };

  const send = async (text: string, files: PendingImage[]) => {
    if (!text.trim() && files.length === 0) return;
    const outgoing = files.map(f => ({ data: f.data, mediaType: f.mediaType, filename: f.filename }));
    if (onDraftComposer) {
      const threadId = await createThread();
      localUser(text, false, outgoing);
      await sendMutation.mutateAsync({ text, files: outgoing });
      clearPendingHandoff(sessionId);
      seedThreadMessageCache(threadId, text, files);
      void navigate(`/factories/${factoryId}/threads/${threadId}`, { replace: true });
      return;
    }
    localUser(text, false, outgoing);
    await sendMutation.mutateAsync({ text, files: outgoing });
    clearPendingHandoff(sessionId);
  };

  // Images leave the composer while in flight and come back if the send fails.
  const withPendingImages = async (run: (files: PendingImage[]) => Promise<unknown>) => {
    const files = images;
    setImages([]);
    try {
      await run(files);
    } catch (error) {
      setImages(current => [...files, ...current]);
      throw error;
    }
  };

  // A session's message: its images and files are stored as the card's attachments first and named in the text.
  const sendWithAttachments = async (message: string) => {
    const pendingFiles = files;
    setFiles([]);
    try {
      await withPendingImages(async sentImages => {
        const stored = await uploadAttachments(sentImages, pendingFiles);
        await send(withAttachmentLines(message, stored), imagesToModel ? sentImages : []);
      });
    } catch (error) {
      setFiles(current => [...pendingFiles, ...current]);
      throw error;
    }
  };

  const steer = async (text: string) => {
    if (!text.trim()) return;
    const localId = localUser(text, true);
    scroller?.scrollToEnd({ behavior: 'smooth' });
    try {
      await sendMutation.mutateAsync({ text });
      clearPendingHandoff(sessionId);
    } catch (error) {
      failLocalUser(localId);
      throw error;
    }
  };

  const submitInput = (text: string) => {
    if (onUserDraft && !claudeCode && modelLoading && !isSlashCommand(text)) {
      setHeldDraftText(text);
      return;
    }
    const runsCommand = !planFeedback.pending && isSlashCommand(text);
    const sentAnnotations = runsCommand ? [] : takeAnnotations();
    const sentRefs = runsCommand ? [] : refs;
    if (sentRefs.length > 0) setRefs([]);
    updateDraft('');
    void handleInput(text, sentAnnotations, sentRefs).catch(error => {
      restoreAnnotations(sentAnnotations);
      if (sentRefs.length > 0) setRefs(current => sentRefs.reduce(withRef, current));
      if (planFeedback.pending) updateDraft(text);
      clearPending();
      pushNotice(error instanceof Error ? error.message : t('composer.sendFailed'), 'error');
    });
  };

  const sendHeldDraft = useEffectEvent((text: string) => {
    setHeldDraftText(undefined);
    if (modelError) pushNotice(modelError.message, 'error');
    else submitInput(text);
  });
  useEffect(() => {
    if (heldDraftText !== undefined && !modelLoading) sendHeldDraft(heldDraftText);
  }, [heldDraftText, modelLoading]);

  const onSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (sendDisabled || !hasSubmittableDraft) return;
    submitInput(shownText.trim());
  };

  // A full-screen document sends its notes from its own "Send all": the same send as this button, with the draft.
  const sendRequested = useEffectEvent(() => {
    if (annotations.length === 0) return;
    if (sendDisabled) {
      pushNotice(t('composer.sendFailed'), 'error');
      return;
    }
    submitInput(shownText.trim());
  });
  useEffect(() => {
    if (sendRequests > 0) sendRequested();
  }, [sendRequests]);

  const commandMenu = useComposerCommands({
    commands,
    value: shownText,
    onValueChange: updateDraft,
    inputRef,
    enabled: !planFeedback.pending,
    onSubmit: text => {
      if (!sendDisabled) submitInput(text);
    },
  });

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.defaultPrevented) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e);
    }
  };

  async function handleInput(text: string, sentAnnotations: readonly ChatAnnotation[], sentRefs: readonly FactoryRef[]) {
    const message = serializeRefs(formatAnnotatedMessage(text, sentAnnotations), sentRefs);
    if (planFeedback.pending) {
      await planFeedback.submitFeedback(message);
      setImages([]);
      return;
    }
    if (onUserDraft && isSlashCommand(text)) {
      if (commandRequiresReadySession(commands, text)) {
        updateDraft(text);
        pushNotice(t('composer.commandNeedsSession'));
      } else {
        await runComposerCommand(text);
      }
      return;
    }
    if (onUserDraft) {
      try {
        await withPendingImages(async files => createSessionFromDraft({ prompt: message, files }));
      } catch (error) {
        updateDraft(text);
        throw error;
      }
      return;
    }
    if (preparingThreadId && isSlashCommand(text) && commandRequiresReadySession(commands, text)) {
      updateDraft(text);
      pushNotice(t('composer.commandsWaitForSession'));
      return;
    }
    if (await runComposerCommand(text)) return;
    if (liveRun) {
      await steer(message);
      return;
    }
    await sendWithAttachments(message);
  }

  return (
    <ComposerRoot onSubmit={onSubmit} onDrop={onComposerDrop} onDragOver={onComposerDragOver}>
      <ComposerHeader open={connectionNotice.open}>
        <ComposerConnectionNotice notice={connectionNotice.notice} />
      </ComposerHeader>
      <ComposerRing busy={(busy || chatPreparing || startingDraft) && !connectionLost}>
        <ComposerBox
          className={cn(composerProviderState.composerFrameClassName, composerProviderState.composerSurfaceClassName)}
        >
          <ComposerSuggestions {...commandMenu.suggestionsProps} />
          <ComposerAnnotations />
          <ComposerFactoryRefs refs={refs} onRemove={removeRef} />
          <ComposerImageAttachments images={images} onRemove={removeImage} />
          <ComposerFileAttachments files={files} onRemove={removeFile} />
          <ComposerInput
            {...commandMenu.inputProps}
            ref={inputRef}
            onKeyDown={onComposerKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            disabled={textareaDisabled}
            readOnly={preview !== undefined}
            style={preview ? { height: preview.height } : undefined}
            variant={variant}
            aria-label={t('composer.message')}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptFiles ? undefined : 'image/*'}
            multiple
            onChange={onFileInputChange}
            className="hidden"
            aria-label={acceptFiles ? t('composer.attachFiles') : t('composer.attachImages')}
          />
          <ComposerActions>
            <StatusLine />
            <ButtonsGroup size="sm" className="ml-auto" aria-label={t('composer.actions')}>
              <Button
                type="button"
                size="icon-sm"
                disabled={attachDisabled}
                onClick={() => fileInputRef.current?.click()}
                aria-label={acceptFiles ? t('composer.attachFiles') : t('composer.attachImage')}
                tooltip={acceptFiles ? t('composer.filesHint') : t('composer.imagesOnly')}
              >
                <Paperclip size={14} />
              </Button>
              <ComposerPrimaryAction
                showAbort={liveRun && !hasSubmittableDraft}
                sendDisabled={sendDisabled || !hasSubmittableDraft}
                sendTitle={sendTitle}
                onAbort={() => void abortMutation.mutateAsync()}
              />
            </ButtonsGroup>
          </ComposerActions>
        </ComposerBox>
      </ComposerRing>
    </ComposerRoot>
  );
}
