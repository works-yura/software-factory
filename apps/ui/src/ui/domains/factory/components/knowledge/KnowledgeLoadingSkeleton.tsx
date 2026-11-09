import { Skeleton } from '@mastra/playground-ui/components/Skeleton';

/** Placeholder shaped like the Knowledge graph, shown while its first load is pending. */
export function KnowledgeLoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="border-border relative min-h-64 flex-1 overflow-hidden rounded-lg border"
    >
      <div aria-hidden className="absolute inset-0 flex items-center justify-center gap-8">
        <div className="flex flex-col items-center gap-16">
          <Skeleton className="size-5 rounded-full motion-reduce:before:animate-none" />
          <Skeleton className="size-8 rounded-full motion-reduce:before:animate-none" />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-px w-8 motion-reduce:before:animate-none" />
          <Skeleton className="size-12 rounded-full motion-reduce:before:animate-none" />
          <Skeleton className="h-px w-8 motion-reduce:before:animate-none" />
        </div>
        <div className="flex flex-col items-center gap-16">
          <Skeleton className="size-8 rounded-full motion-reduce:before:animate-none" />
          <Skeleton className="size-5 rounded-full motion-reduce:before:animate-none" />
        </div>
      </div>
    </div>
  );
}
