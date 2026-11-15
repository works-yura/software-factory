import type { AuthorizationPrompt, ConnectFormField, ConnectMethod, ConnectResult, ConnectorView, ConnectWaiting } from '@factory/contracts';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChevronRight, ExternalLink, RotateCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { useAuthorize, useReconnect } from '../../../../../hooks/useConnections';
import { ConnectionApiError, connectionsApi, finishAuthorize } from '../../connections/api';
import type { ConnectionTarget } from './ConnectSteps';
import { StepFrame } from './ConnectSteps';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One way in, as the method list shows it: its label and line, or — unavailable — why not, disabled. */
function MethodRow({ method, onSelect }: { method: ConnectMethod; onSelect: () => void }) {
  const reasonId = useId();
  const blocked = method.available !== true ? method.available.reason : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={blocked !== undefined}
        aria-describedby={blocked ? reasonId : undefined}
        className="text-body-sm text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:bg-fill focus-visible:text-foreground flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none disabled:pointer-events-none"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`text-body-sm truncate ${blocked ? 'text-muted-foreground' : 'text-foreground'}`}>{method.label}</span>
          {method.description && !blocked && <span className="text-meta text-muted-foreground">{method.description}</span>}
          {blocked && (
            <span id={reasonId} className="text-meta text-muted-foreground">
              {blocked}
            </span>
          )}
        </span>
        {!blocked && <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0" />}
      </button>
    </li>
  );
}

/** One field of a form method, as the server describes it; `file` reads a picked file into the value. */
export function FormField({
  field,
  value,
  error,
  onChange,
}: {
  field: Pick<ConnectFormField, 'name' | 'displayName' | 'description' | 'placeholder' | 'accept' | 'required' | 'default' | 'options'> & { type: string };
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const id = useId();
  const hintId = useId();
  const describedBy = field.description || error ? hintId : undefined;
  const common = {
    id,
    value: value || (field.default ?? ''),
    required: field.required === true,
    spellCheck: false,
    autoComplete: 'off',
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id}>
        <Txt as="span" variant="label" tone="ink">
          {field.displayName}
        </Txt>
      </label>
      {field.type === 'select' ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} aria-label={field.displayName} {...(describedBy ? { 'aria-describedby': describedBy } : {})}>
            {field.options?.find(option => option.value === value)?.label ?? field.placeholder ?? t('connections.connector.choose')}
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'textarea' || field.type === 'file' ? (
        <Textarea {...common} rows={6} className="font-mono text-xs" onChange={event => onChange(event.target.value)} />
      ) : (
        <Input {...common} type={field.type === 'secret' ? 'password' : 'text'} onChange={event => onChange(event.target.value)} />
      )}
      {field.type === 'file' && (
        <label className="flex min-h-11 cursor-pointer items-center self-start md:min-h-0">
          <input
            type="file"
            accept={field.accept}
            className="sr-only"
            aria-label={t('connections.connect.pickFile')}
            onChange={async event => {
              const file = event.target.files?.[0];
              if (file) onChange(await file.text());
            }}
          />
          <Txt as="span" variant="caption" tone="muted" className="underline">
            {t('connections.connect.pickFile')}
          </Txt>
        </label>
      )}
      {(error || field.description) && (
        <Txt as="p" id={hintId} variant="caption" tone="muted" className={error ? 'text-destructive-foreground' : undefined}>
          {error ?? field.description}
        </Txt>
      )}
    </div>
  );
}

/**
 * What the person does in this browser while a sign-in the server runs waits (the server may be another
 * machine): open the provider's page in a new tab, enter the code shown here on it (a device code), or
 * paste back the code that page shows them.
 */
function AuthorizationPromptPanel({
  prompt,
  onSubmitCode,
}: {
  prompt: AuthorizationPrompt | undefined;
  onSubmitCode: (code: string) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const codeId = useId();
  const hintId = useId();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent' | { error: string }>('idle');
  // Only a page of the provider's, over https, is ever a link here.
  const url = prompt?.url && /^https:\/\//i.test(prompt.url) ? prompt.url : undefined;
  if (!url) {
    return (
      <Txt as="p" variant="caption" tone="muted" className="flex items-center gap-2" role="status">
        <Spinner size="sm" aria-hidden />
        {t('connections.connect.preparingSignIn')}
      </Txt>
    );
  }
  const submit = async () => {
    if (!code.trim() || sending === 'sending') return;
    setSending('sending');
    try {
      await onSubmitCode(code.trim());
      setSending('sent');
    } catch (error) {
      setSending({ error: errorMessage(error) });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Button
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        size="sm"
        variant="primary"
        icon={<ExternalLink aria-hidden />}
        className="self-start"
      >
        {t('connections.connect.openSignInPage')}
      </Button>
      {prompt?.userCode && (
        <div className="flex flex-col gap-1">
          <Txt as="span" variant="label" tone="ink">
            {t('connections.connect.userCodeLabel')}
          </Txt>
          <code className="text-body-sm font-mono tracking-widest select-all" aria-label={t('connections.connect.userCodeLabel')}>
            {prompt.userCode}
          </code>
        </div>
      )}
      {(prompt?.acceptsCode || sending !== 'idle') && (
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={codeId}>
            <Txt as="span" variant="label" tone="ink">
              {t('connections.connect.pasteCodeLabel')}
            </Txt>
          </label>
          <div className="flex min-w-0 gap-2">
            <Input
              id={codeId}
              value={code}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={hintId}
              disabled={sending === 'sending' || sending === 'sent'}
              className="min-w-0 flex-1 font-mono"
              onChange={event => setCode(event.target.value)}
            />
            <Button type="submit" size="sm" variant="default" disabled={!code.trim() || sending === 'sending' || sending === 'sent'}>
              {sending === 'sending' && <Spinner size="sm" aria-hidden />}
              {t('connections.connect.submitCode')}
            </Button>
          </div>
          <Txt as="p" id={hintId} variant="caption" tone="muted">
            {sending === 'sent' ? t('connections.connect.codeSent') : t('connections.connect.pasteCodeHint')}
          </Txt>
          {typeof sending === 'object' && (
            <Notice variant="destructive" title={t('connections.connect.codeFailed')} role="alert">
              <Notice.Message>{sending.error}</Notice.Message>
            </Notice>
          )}
        </form>
      )}
    </div>
  );
}

/**
 * Connect (or reconnect) through one connector, entirely from the server's descriptors: with several
 * methods it first asks which (an unavailable one says why); a redirect method opens the URL the
 * server returns; a form method renders its fields, shows a refusal on the field it concerns, and on
 * success says what was connected and opens it. The step knows no provider.
 */
export function ConnectorConnect({
  connector,
  methods,
  reconnect,
  title,
  onBack,
  onPick,
}: {
  connector: Pick<ConnectorView, 'id' | 'name' | 'icon' | 'description'>;
  methods: ConnectMethod[];
  /** Reconnecting this connection (its id) instead of adding one. */
  reconnect?: string;
  title?: string;
  onBack: () => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const connect = useAuthorize();
  const reconnectMutation = useReconnect();
  const mutation = reconnect ? reconnectMutation : connect;
  const single = methods.length === 1 ? methods[0] : undefined;
  const [chosenId, setChosenIdState] = useState<string | undefined>(single?.editor ? undefined : single?.id);
  // The one custom editor (ADR-0035) is a page, not a form: choosing its method opens that page.
  const setChosenId = (id: string | undefined) => {
    const picked = methods.find(candidate => candidate.id === id);
    if (picked?.editor) onPick({ connection: `new:${connector.id}:${picked.id}` });
    else setChosenIdState(id);
  };
  const method = methods.find(candidate => candidate.id === chosenId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Extract<ConnectResult, { type: 'connected' }>>();
  /** A session run here (a provider popup): in progress, finished, still confirming, or failed. */
  const [authorizing, setAuthorizing] = useState<'running' | 'completed' | 'pending' | { error: string }>();
  /** What to tell the person while a flow finishes elsewhere (a CLI's sign-in page on the server's machine). */
  const [waiting, setWaiting] = useState<ConnectWaiting>();
  /** The flow that waits, and what its latest status asks of the person (the page to open, a code). */
  const [flow, setFlow] = useState<{ authId: string; controller: AbortController }>();
  const [prompt, setPrompt] = useState<AuthorizationPrompt>();
  const queryClient = useQueryClient();
  const frame = {
    kind: connector.icon,
    title: title ?? t('connections.connect.title', { name: connector.name }),
    subtitle: connector.description ?? '',
  };

  const run = (input: Record<string, string>) => {
    if (!method) return;
    const handle = {
      onSuccess: (result: ConnectResult) => {
        if (result.type === 'connected') {
          setDone(result);
          return;
        }
        if (result.session || result.waiting) setAuthorizing('running');
        setWaiting(result.waiting);
        setPrompt(undefined);
        const controller = new AbortController();
        if (result.waiting && result.authId) setFlow({ authId: result.authId, controller });
        finishAuthorize(baseUrl, connector.id, result, {
          signal: controller.signal,
          onStatus: status => setPrompt(status.status === 'pending' ? status.prompt : undefined),
        }).then(
          outcome => {
            if (outcome === 'redirected' || controller.signal.aborted) return;
            setAuthorizing(outcome);
            void queryClient.invalidateQueries();
          },
          (error: unknown) => {
            if (!controller.signal.aborted) setAuthorizing({ error: errorMessage(error) });
          },
        );
      },
    };
    if (reconnect) reconnectMutation.mutate({ id: reconnect, input }, handle);
    else connect.mutate({ connector: connector.id, method: method.id, input }, handle);
  };

  // Closing the dialog while a sign-in waits stops it too.
  const waitingFlow = useRef<typeof flow>(undefined);
  useEffect(() => {
    waitingFlow.current = authorizing === 'running' ? flow : undefined;
  }, [authorizing, flow]);
  useEffect(
    () => () => {
      const open = waitingFlow.current;
      if (!open) return;
      open.controller.abort();
      void connectionsApi.cancelAuth(baseUrl, connector.id, open.authId).catch(() => undefined);
    },
    [baseUrl, connector.id],
  );

  /** Going back from a sign-in that still waits stops it: the server's CLI would otherwise wait out its timeout. */
  const stopWaiting = () => {
    if (!flow || authorizing !== 'running') return;
    waitingFlow.current = undefined;
    flow.controller.abort();
    void connectionsApi.cancelAuth(baseUrl, connector.id, flow.authId).catch(() => undefined);
    setFlow(undefined);
    setPrompt(undefined);
    setAuthorizing(undefined);
  };

  const back = () => {
    stopWaiting();
    mutation.reset();
    if (method && !single) setChosenIdState(undefined);
    else onBack();
  };

  if (authorizing === 'completed' || authorizing === 'pending') {
    return (
      <StepFrame
        {...frame}
        onBack={onBack}
        action={
          <Button size="sm" variant="primary" onClick={() => onPick({ connection: connector.id })}>
            {t('connections.connector.open')}
          </Button>
        }
      >
        <Notice variant={authorizing === 'completed' ? 'success' : 'info'} title={t(`connections.connector.authorized.${authorizing}`, { name: connector.name })} role="status" />
      </StepFrame>
    );
  }

  if (done) {
    return (
      <StepFrame
        {...frame}
        onBack={onBack}
        action={
          <Button size="sm" variant="primary" onClick={() => onPick({ connection: done.connection.id })}>
            {t('connections.connector.open')}
          </Button>
        }
      >
        <Notice variant="success" title={done.title} role="status">
          {done.message && <Notice.Message>{done.message}</Notice.Message>}
        </Notice>
      </StepFrame>
    );
  }

  if (!method) {
    return (
      <StepFrame {...frame} onBack={onBack}>
        <Txt as="p" variant="caption" tone="muted">
          {t('connections.connector.chooseMethod')}
        </Txt>
        <ul className="-mx-2 flex flex-col gap-0.5" aria-label={t('connections.connector.chooseMethod')}>
          {methods.map(candidate => (
            <MethodRow key={candidate.id} method={candidate} onSelect={() => setChosenId(candidate.id)} />
          ))}
        </ul>
      </StepFrame>
    );
  }

  const failure = mutation.error;
  const fieldErrors = failure instanceof ConnectionApiError ? (failure.body.fields ?? {}) : {};
  const blocked = method.available !== true ? method.available.reason : undefined;
  const fields = method.fields ?? [];
  const missing = fields.some(field => field.required && !(values[field.name] ?? '').trim());
  const formId = `connect-${connector.id}-${method.id}`;
  const submitLabel = method.authKind === 'oauth' && fields.length === 0 ? t('connections.connect.continue') : (method.submitLabel ?? t('connections.connect.submit'));

  return (
    <StepFrame
      {...frame}
      onBack={back}
      action={
        blocked ? undefined : (
          <Button
            size="sm"
            variant="primary"
            type={fields.length > 0 ? 'submit' : 'button'}
            form={fields.length > 0 ? formId : undefined}
            disabled={mutation.isPending || authorizing === 'running' || missing}
            onClick={fields.length === 0 ? () => run({}) : undefined}
          >
            {mutation.isPending || authorizing === 'running' ? (
              <>
                <Spinner size="sm" aria-hidden />
                {t('connections.connect.connecting')}
              </>
            ) : failure ? (
              <>
                <RotateCw aria-hidden className="size-4" />
                {t('connections.connect.retry')}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        )
      }
    >
      {blocked && <Notice variant="info" title={blocked} role="status" />}
      {authorizing === 'running' && waiting && (
        <Notice variant="info" title={waiting.title} role="status">
          {waiting.message && <Notice.Message>{waiting.message}</Notice.Message>}
        </Notice>
      )}
      {authorizing === 'running' && waiting && flow && (
        <AuthorizationPromptPanel
          key={flow.authId}
          prompt={prompt}
          onSubmitCode={async code => {
            await connectionsApi.submitAuthCode(baseUrl, connector.id, flow.authId, code);
          }}
        />
      )}
      {failure && Object.keys(fieldErrors).length === 0 && (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{errorMessage(failure)}</Notice.Message>
        </Notice>
      )}
      {typeof authorizing === 'object' && (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{authorizing.error}</Notice.Message>
        </Notice>
      )}
      {method.description && (
        <Txt as="p" variant="caption" tone="muted">
          {method.description}
        </Txt>
      )}
      {fields.length > 0 && !blocked && (
        <form
          id={formId}
          className="flex min-w-0 flex-col gap-3"
          onSubmit={event => {
            event.preventDefault();
            if (!missing) run(values);
          }}
        >
          {fields.map(field => (
            <FormField
              key={field.name}
              field={field}
              value={values[field.name] ?? ''}
              {...(fieldErrors[field.name] ? { error: fieldErrors[field.name] } : {})}
              onChange={value => setValues(current => ({ ...current, [field.name]: value }))}
            />
          ))}
        </form>
      )}
    </StepFrame>
  );
}
