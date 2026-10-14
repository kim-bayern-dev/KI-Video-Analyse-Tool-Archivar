import { createRef, t, type Ref, type Props, $, Reactive, createStore } from "defuss";
import type { FileInfo, FileSummary } from "../../../rpc/file-api.js";

/**
 * Imperative API exposed to the parent dashboard via ref.state: the
 * dashboard calls setFiles after listing/refresh/delete, getSelectedFile for
 * the analyze/delete actions, getFiles for the delete-follow-up selection,
 * and setSelectedFile to activate the previous (or first) file after a
 * delete (screens/dashboard.tsx).
 */
// A list row only needs the summary subset (fileName + media type); the selected
// entry may be a FileSummary (the dashboard fetches the full FileInfo on demand).
export type FileListEntry = FileInfo | FileSummary;

export interface FileListRef {
  setFiles: (files: FileListEntry[]) => void;
  setSelectedFile: (file: FileListEntry | null) => void;
  getSelectedFile: () => FileListEntry | null;
  getFiles: () => FileListEntry[];
}

/**
 * The callbacks are owned by the parent dashboard; the FileList itself only
 * manages display and selection state.
 */
export interface FileListProps extends Props {
  files?: FileListEntry[];
  onFileChange?: (fileInfo: FileListEntry) => void;
  onFileDelete?: (fileInfo: FileListEntry) => void;
  onUploadClick?: () => void;
  onRefreshClick?: () => void;
  ref?: Ref<HTMLDivElement, FileListRef>;
}

/**
 * File table for the dashboard sidebar. A row click selects the file and
 * notifies the parent via onFileChange; the toolbar buttons delegate
 * refresh/upload/delete to the parent (delete stays disabled until a
 * selection exists).
 */
export const FileList = ({ files = [], onFileChange, onFileDelete, onUploadClick, onRefreshClick, ref = createRef<HTMLDivElement, FileListRef>() }: FileListProps) => {

  const fileListTableRef = createRef<HTMLTableSectionElement>();
  const deleteButtonRef = createRef<HTMLButtonElement>();

  // Create a store for selected file to enable reactive re-rendering
  const selectedFileStore = createStore<FileListEntry | null>(null);

  // The files array is deliberately NOT reactive: it lives in a plain closure
  // variable, so setFiles must re-render imperatively via $().update() below.
  // Selection, on the other hand, flows through the store + <Reactive> —
  // two rendering mechanisms coexist in this component.
  let localFiles: FileListEntry[] = files;

  const updateDeleteButton = (selectedFile: FileListEntry | null) => {
    if (deleteButtonRef.current) {
      deleteButtonRef.current.disabled = !selectedFile;
    }
  };

  // Icon from the server-side classification (FileInfo.mediaType, derived from
  // the shared VIDEO/AUDIO/IMAGE_EXTENSIONS lists in src/lib/media-extensions.ts).
  const getFileType = (file: FileListEntry): string => {
    switch (file.mediaType) {
      case 'kfs': return '📂';
      case 'video': return '🎥';
      case 'audio': return '🎵';
      case 'image': return '🖼️';
      default: return '📄';
    }
  };

  // Full programmatic activation, identical to a row click: highlight, enable
  // delete, notify the dashboard, and scroll the row into view.
  const selectFile = (file: FileListEntry) => {
    selectedFileStore.set(file);
    // The store-driven <Reactive> re-render alone can miss the new
    // highlight after setFiles replaced the tbody DOM the Reactive
    // was bound to — so refresh the rows imperatively as well.
    $(fileListTableRef).update(buildTableRows(localFiles));
    updateDeleteButton(file);
    onFileChange?.(file);
    fileListTableRef.current
      ?.querySelector(`tr[data-file-name="${CSS.escape(file.fileName)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  // Builds the table rows VDOM using the provided files array
  const buildTableRows = (filesToRender: FileListEntry[]) => (
    <>
      {filesToRender.map(file => {
        const isSelected = selectedFileStore.value?.fileName === file.fileName;
        return (
          <tr
            key={file.fileName}
            className={`cursor-pointer ${isSelected ? 'bg-purple-100' : ''}`}
            data-file-name={file.fileName}
            onClick={() => selectFile(file)}
          >
            <td className="break-words"><span className="whitespace-nowrap">{getFileType(file)}{"\u00A0"}</span>{file.fileName}</td>
          </tr>
        );
      })}
    </>
  );

  // Set up ref.state methods for external access
  const setFilesMethod = (newFiles: FileListEntry[]) => {
    localFiles = newFiles;
    $(fileListTableRef).update(buildTableRows(newFiles));
  };

  const setSelectedFileMethod = (file: FileListEntry | null) => {
    if (file === null) {
      // Deselection (e.g. after delete): clear highlight + delete button only.
      selectedFileStore.set(null);
      updateDeleteButton(null);
      return;
    }
    selectFile(file);
  };

  const getSelectedFileMethod = () => selectedFileStore.value;

  // Expose methods via ref.state for external access
  ref.state = {
    setFiles: setFilesMethod,
    setSelectedFile: setSelectedFileMethod,
    getSelectedFile: getSelectedFileMethod,
    getFiles: () => localFiles,
  };

  return (
    <div>
      <div className="flex items-center justify-between sticky top-0 z-10 bg-white pb-1 border-b-2 border-gray-200 ">
        <h3 className="text-lg font-semibold">{t("dashboard.files_heading")}</h3>
        <div className="flex items-center gap-1">
          <button
            className="uk-btn uk-btn-default uk-btn-sm"
            onClick={() => onRefreshClick?.()}
            title={t("dashboard.refresh_files")}
          >
            🔄
          </button>
          <button
            className="uk-btn uk-btn-default uk-btn-sm"
            onClick={() => onUploadClick?.()}
            title={t("dashboard.upload_file")}
          >
            📤
          </button>
          <button
            ref={deleteButtonRef}
            className="uk-btn uk-btn-default uk-btn-sm text-destructive !border-destructive"
            disabled
            title={t("dashboard.delete_file")}
            onClick={() => {
              const selectedFile = selectedFileStore.value;
              if (selectedFile) onFileDelete?.(selectedFile);
            }}
          >
            🗑️
          </button>
        </div>
      </div>
      <div className="overflow-x-hidden overflow-y-auto file-list-table w-full">
        <table className="uk-table uk-table-divider uk-table-hover uk-table-sm w-full">
          <tbody ref={fileListTableRef}>
            <Reactive
              store={selectedFileStore}
              render={() => buildTableRows(localFiles)}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
};
