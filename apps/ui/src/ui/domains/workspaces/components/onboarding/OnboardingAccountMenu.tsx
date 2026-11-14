import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { useTheme } from '@mastra/playground-ui/components/ThemeProvider';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LogOut, SunMoon } from 'lucide-react';
import { useApiConfig } from '../../../../../api/config';
import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { useThemeOptions } from '../../../../i18n/useThemeOptions';
import { translator } from '../../../../i18n/t';
import { accountName } from '../../../auth/services/accountName';
import { signOutOfOnboarding } from '../../services/onboardingSignOut';

const tk = translator('workspaces');

/**
 * Who is setting up this Factory, the theme, and a way out. With sign-in off there is no account, so the
 * menu holds only the theme.
 */
export function OnboardingAccountMenu() {
  const auth = useFactoryAuth();
  const { baseUrl } = useApiConfig();
  const { theme, setTheme } = useTheme();
  const themeOptions = useThemeOptions();
  // Wait for auth so a signed-in user never sees the theme-only trigger flash first.
  if (auth.isPending) return null;
  const user = auth.data?.authEnabled ? auth.data.user : undefined;
  if (!user)
    return (
      <DropdownMenu>
        <DropdownMenu.Trigger variant="ghost" size="icon-md" aria-label={tk('onboarding.account.theme')}>
          <SunMoon aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.RadioOptions options={themeOptions} value={theme} onValueChange={setTheme} closeOnSelect />
        </DropdownMenu.Content>
      </DropdownMenu>
    );
  const displayName = accountName(user) ?? tk('onboarding.account.fallbackName');
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger variant="ghost" aria-label={tk('onboarding.account.menuFor', { name: displayName })}>
        <Avatar src={user.avatarUrl} name={displayName} size="sm" />
        <Txt as="span" variant="label" className="max-w-40 truncate max-[899px]:hidden">
          {displayName}
        </Txt>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {user.email && <DropdownMenu.Label>{user.email}</DropdownMenu.Label>}
        <DropdownMenu.RadioSub
          label={tk('onboarding.account.theme')}
          icon={<SunMoon aria-hidden />}
          options={themeOptions}
          value={theme}
          onValueChange={setTheme}
        />
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => signOutOfOnboarding(baseUrl)}>
          <LogOut aria-hidden="true" />
          {tk('onboarding.account.signOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
