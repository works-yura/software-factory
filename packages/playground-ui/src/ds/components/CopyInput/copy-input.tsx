import { CopyButton } from '../CopyButton';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../InputGroup';
import type { InputGroupInputProps } from '../InputGroup';
import { libText } from '@/lib/lib-text';

export type CopyInputProps = Omit<
  InputGroupInputProps,
  'value' | 'readOnly' | 'defaultValue' | 'aria-label' | 'aria-labelledby'
> & {
  value: string;
  /** What's being copied, e.g. "organization ID": names the input and the copy button. */
  label: string;
  /** The copy button's name when "Copy {label}" doesn't read right, e.g. in a host's translation. */
  copyLabel?: string;
};

/** A read-only value people copy, like an ID or a URL: shown in an input so it reads and selects like one. */
export function CopyInput({ value, label, copyLabel, className, disabled, ...props }: CopyInputProps) {
  return (
    <InputGroup className={className}>
      <InputGroupInput {...props} aria-label={label} value={value} readOnly spellCheck={false} disabled={disabled} />
      <InputGroupAddon align="inline-end">
        <CopyButton content={value} tooltip={copyLabel ?? `${libText('Copy')} ${label}`} variant="ghost" disabled={disabled} />
      </InputGroupAddon>
    </InputGroup>
  );
}
