import { Button } from '@mastra/playground-ui/components/Button';
import { Settings2 } from 'lucide-react';
import { Link } from 'react-router';

import { boardConfigPath } from '../boardConfigPaths';
import { translator } from '../../../i18n/t';

const tk = translator('boardConfig');

/** Opens the board's configuration: its phases and, on built-in boards, the factory's automation. */
export function ConfigureBoardButton({ factoryId, boardId }: { factoryId: string; boardId: string }) {
  return (
    <Button
      variant="default"
      size="icon-sm"
      aria-label={tk('configureBoard')}
      tooltip={tk('configureBoard')}
      render={<Link to={boardConfigPath(factoryId, boardId)} />}
    >
      <Settings2 aria-hidden />
    </Button>
  );
}
