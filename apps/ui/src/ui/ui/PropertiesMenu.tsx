import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import type { DropdownMenuTriggerProps } from '@mastra/playground-ui/components/DropdownMenu';
import { RotateCcw, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function PropertiesMenu({
  label,
  changedCount,
  changes = [],
  onReset,
  align = 'start',
  variant = 'ghost',
  icon = <Settings2 size={15} aria-hidden />,
  children,
}: {
  label: string;
  changedCount: number;
  changes?: readonly string[];
  onReset: () => void;
  align?: 'start' | 'end';
  variant?: DropdownMenuTriggerProps['variant'];
  icon?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('app');
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        variant={variant}
        size={changedCount === 0 ? 'icon-sm' : 'sm'}
        aria-label={changedCount === 0 ? label : t('properties.changed', { label, changed: changedCount })}
        tooltip={
          changes.length === 0 ? (
            label
          ) : (
            <span className="flex flex-col">
              <span>{label}</span>
              {changes.map(change => (
                <span key={change} className="text-muted-foreground">
                  {change}
                </span>
              ))}
            </span>
          )
        }
      >
        {icon}
        {changedCount > 0 && <span className="tabular-nums">{changedCount}</span>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align={align}>
        {children}
        <DropdownMenu.Separator />
        <DropdownMenu.Item disabled={changedCount === 0} onClick={onReset}>
          <RotateCcw aria-hidden />
          <span>{t('properties.reset')}</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
