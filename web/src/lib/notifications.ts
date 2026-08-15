import { toast, type ExternalToast } from "sonner";

type NotificationOptions = Pick<ExternalToast, "action" | "description" | "duration" | "id">;

const DEFAULT_DURATION_MS = 4_500;
const ERROR_DURATION_MS = 7_000;

function optionsWithDuration(options: NotificationOptions | undefined, duration: number): ExternalToast {
  return { duration, ...options };
}

export const notify = {
  success(title: string, options?: NotificationOptions) {
    return toast.success(title, optionsWithDuration(options, DEFAULT_DURATION_MS));
  },
  error(title: string, options?: NotificationOptions) {
    return toast.error(title, optionsWithDuration(options, ERROR_DURATION_MS));
  },
  warning(title: string, options?: NotificationOptions) {
    return toast.warning(title, optionsWithDuration(options, 6_000));
  },
  info(title: string, options?: NotificationOptions) {
    return toast.info(title, optionsWithDuration(options, DEFAULT_DURATION_MS));
  },
  loading(title: string, options?: NotificationOptions) {
    return toast.loading(title, { duration: Number.POSITIVE_INFINITY, ...options });
  },
  dismiss(id?: string | number) {
    return toast.dismiss(id);
  },
};
