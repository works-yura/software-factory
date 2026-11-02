import { CopyButton } from '../CopyButton';
import { libText } from '@/lib/lib-text';

export function MessageCopyButton({ text }: { text: string }) {
  return <CopyButton content={text} size="icon-sm" variant="ghost" tooltip={libText('Copy message')} showToast={false} />;
}
