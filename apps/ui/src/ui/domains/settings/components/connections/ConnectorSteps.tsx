import type { ConnectFormField, ConnectMethod, ConnectResult, ConnectorView } from '@factory/contracts';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChevronRight, RotateCw } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { useAuthorize, useReconnect } from '../../../../../hooks/useConnections';
import { ConnectionApiError, connectionNavigation, connectionRedirectUrl } from '../../connections/api';
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
function FormField({
  field,
  value,
  error,
  onChange,
}: {
  field: ConnectFormField;
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
      {field.type === 'textarea' || field.type === 'file' ? (
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
  const [chosenId, setChosenId] = useState<string | undefined>(single?.id);
  const method = methods.find(candidate => candidate.id === chosenId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Extract<ConnectResult, { type: 'connected' }>>();
  const frame = {
    kind: connector.icon,
    title: title ?? t('connections.connect.title', { name: connector.name }),
    subtitle: connector.description ?? '',
  };

  const run = (input: Record<string, string>) => {
    if (!method) return;
    const handle = {
      onSuccess: (result: ConnectResult) => {
        if (result.type === 'authorize') connectionNavigation.assign(connectionRedirectUrl(baseUrl, result.url));
        else setDone(result);
      },
    };
    if (reconnect) reconnectMutation.mutate({ id: reconnect, input }, handle);
    else connect.mutate({ connector: connector.id, method: method.id, input }, handle);
  };

  const back = () => {
    mutation.reset();
    if (method && !single) setChosenId(undefined);
    else onBack();
  };

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
            disabled={mutation.isPending || missing}
            onClick={fields.length === 0 ? () => run({}) : undefined}
          >
            {mutation.isPending ? (
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
      {failure && Object.keys(fieldErrors).length === 0 && (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{errorMessage(failure)}</Notice.Message>
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
