import { CopyIcon, CheckIcon } from 'lucide-react';

import type { ButtonProps } from '../Button';
import { Button } from '../Button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { libText } from '@/lib/lib-text';

export type CopyButtonProps = {
  content: string;
  copyMessage?: string;
  showToast?: boolean;
  tooltip?: string;
  className?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
};

export function CopyButton({
  content,
  copyMessage,
  showToast,
  tooltip = libText('Copy to clipboard'),
  size = 'sm',
  variant,
  className,
}: CopyButtonProps) {
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: content,
    copyMessage,
    showToast,
  });

  return (
    <Button
      onClick={handleCopy}
      type="button"
      size={size}
      variant={variant}
      className={className}
      tooltip={isCopied ? libText('Copied!') : tooltip}
      aria-label={isCopied ? libText('Copied!') : tooltip}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
