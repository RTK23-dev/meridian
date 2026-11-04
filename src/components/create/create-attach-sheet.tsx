import { useRef, type ReactNode } from "react";
import { Camera, FileUp, Image as ImageIcon, X } from "lucide-react";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui";
import { CREATE_ACCEPT } from "./create-model";

/**
 * The plus button's sheet: three ways to add material, each a large tile, as in the chat apps. Photos and video come from the library,
 * Camera opens the camera on a phone, and Files takes any type Meridian accepts. Nothing is uploaded here: the chosen files are kept with
 * the message and stored when it is sent, so the sheet never spends or stores anything by itself.
 */
export function CreateAttachSheet({ open, onOpenChange, onFiles }: { open: boolean; onOpenChange: (open: boolean) => void; onFiles: (files: File[]) => void }) {
  const camera = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);

  function picked(list: FileList | null) {
    if (list && list.length > 0) onFiles(Array.from(list));
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="rounded-t-sharp border-t border-x-0 border-b-0 px-5 pb-8 pt-3">
        <div aria-hidden="true" className="mx-auto mb-5 h-1 w-10 rounded-sharp bg-border-strong" />
        <div className="grid grid-cols-[44px_1fr_44px] items-center">
          <SheetClose aria-label="Close" className="grid size-11 place-items-center rounded-sharp text-fg-primary transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <X aria-hidden="true" className="size-5" />
          </SheetClose>
          <SheetTitle className="text-center text-base font-semibold text-fg-primary">Add to your message</SheetTitle>
          <span aria-hidden="true" />
        </div>
        <SheetDescription className="sr-only">Choose a camera photo, photos or video from your library, or a file. Files are stored when the message is sent.</SheetDescription>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <Tile icon={<Camera aria-hidden="true" className="size-6" />} label="Camera" onActivate={() => camera.current?.click()} />
          <Tile icon={<ImageIcon aria-hidden="true" className="size-6" />} label="Photos & video" onActivate={() => photos.current?.click()} />
          <Tile icon={<FileUp aria-hidden="true" className="size-6" />} label="Files" onActivate={() => files.current?.click()} />
        </div>

        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { picked(event.target.files); event.target.value = ""; }} />
        <input ref={photos} type="file" accept="image/*,video/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { picked(event.target.files); event.target.value = ""; }} />
        <input ref={files} type="file" accept={CREATE_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { picked(event.target.files); event.target.value = ""; }} />
      </SheetContent>
    </Sheet>
  );
}

function Tile({ icon, label, onActivate }: { icon: ReactNode; label: string; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="flex aspect-[4/3] flex-col items-center justify-center gap-2.5 rounded-sharp bg-raised px-2 text-center text-sm font-medium text-fg-primary transition-colors hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
