import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const Checkbox = CheckboxPrimitive.Root;

const CheckboxIndicator = CheckboxPrimitive.Indicator;

export function CheckboxElement(props: React.ComponentProps<typeof CheckboxPrimitive.Root> & { className?: string }) {
  const { className, ...props_ } = props;
  return (
    <Checkbox
      className={cn(
        'rounded-sm border border-input text-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props_}
    >
      <CheckboxIndicator className="flex items-center justify-center">
        <Check className="h-4 w-4" />
      </CheckboxIndicator>
    </Checkbox>
  );
}

export { CheckboxElement as Checkbox };
