import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function ConnectionApiKeyFormShared({
  disabled,
  onCancel,
  onSecretChange,
  onSubmit,
  secret,
}: {
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSecretChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly secret: string;
}) {
  return (
    <div className="flex items-center gap-2" data-pencil-component="h6DyYk">
      <Input
        aria-label="API key"
        className="h-8 min-w-0 flex-1"
        onChange={(event) => onSecretChange(event.currentTarget.value)}
        placeholder="Paste API key"
        type="password"
        value={secret}
      />
      <Button className="h-8 px-3" disabled={disabled} onClick={onSubmit} size="sm">
        Add
      </Button>
      <Button className="h-8 px-3" onClick={onCancel} size="sm" variant="outline">
        Cancel
      </Button>
    </div>
  );
}
