import { createCardActionForm } from './CreateCardActionForm';
import { registerIntakeActionForm, registerIntakeTriggerForm } from './formRegistry';
import { scheduleTriggerForm } from './ScheduleTriggerForm';

// The forms of the kinds this server ships. A new kind registers its form the same way.
registerIntakeTriggerForm(scheduleTriggerForm);
registerIntakeActionForm(createCardActionForm);
