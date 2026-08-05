import React, { useRef, useState } from 'react';
import { Upload, AlertCircle, Check, Loader2, FileText, X } from 'lucide-react';
import { parseImportFile, markDuplicates, type ImportCandidate, type ParsedImport } from '../utils/import';
import { loginIdentifier } from '../types';
import type { LoginItem, VaultItem } from '../types';

/**
 * Import from another password manager.
 *
 * The file is read and parsed in the page — an export is the most sensitive
 * document a person owns, and shipping it somewhere to be converted would give
 * away exactly what the vault exists to protect.
 *
 * Nothing is written until the user confirms. A parse that quietly created
 * hundreds of records would be both alarming and awkward to undo, so the panel
 * always shows what it found, what it will skip, and why.
 */
export function ImportPanel({ existingItems, onImported }: {
    existingItems: VaultItem[];
    onImported: () => Promise<void> | void;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    const [parsed, setParsed] = useState<ParsedImport | null>(null);
    const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [imported, setImported] = useState<number | null>(null);

    const reset = () => {
        setParsed(null);
        setCandidates([]);
        setSelected(new Set());
        setError('');
        setImported(null);
        if (fileInput.current) fileInput.current.value = '';
    };

    const handleFile = async (file: File) => {
        setError('');
        setImported(null);
        try {
            const text = await file.text();
            const result = parseImportFile(file.name, text);
            const marked = markDuplicates(result.candidates, existingItems);

            setParsed(result);
            setCandidates(marked);
            // Duplicates start unticked: re-importing after adding entries by
            // hand is normal, and silently doubling them is not helpful.
            setSelected(new Set(marked.map((c, i) => (c.duplicateOfId ? -1 : i)).filter(i => i >= 0)));
        } catch (e) {
            setParsed(null);
            setCandidates([]);
            setError((e as Error).message);
        }
    };

    const toggle = (index: number) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const commit = async () => {
        setBusy(true);
        const chosen = [...selected].sort((a, b) => a - b).map(i => candidates[i]);
        setProgress({ done: 0, total: chosen.length });

        let saved = 0;
        // Sequential: each item is individually encrypted and written, and
        // firing hundreds of concurrent messages at the worker just makes the
        // failure modes worse.
        for (const candidate of chosen) {
            const response = await chrome.runtime.sendMessage({
                type: 'CREATE_ITEM',
                payload: {
                    itemType: candidate.itemType,
                    data: candidate.data,
                    metadata: candidate.metadata,
                },
            }) as { success: boolean };
            if (response?.success) saved++;
            setProgress(p => ({ ...p, done: p.done + 1 }));
        }

        await onImported();
        setBusy(false);
        setImported(saved);
        setParsed(null);
        setCandidates([]);
        setSelected(new Set());
        if (fileInput.current) fileInput.current.value = '';
    };

    const describe = (candidate: ImportCandidate): string => {
        if (candidate.itemType !== 'login') return candidate.itemType;
        const login = candidate.data as LoginItem;
        return [loginIdentifier(login), login.url].filter(Boolean).join(' · ') || '—';
    };

    return (
        <div className="vw-card p-5">
            <div className="flex items-center gap-2 mb-1">
                <Upload className="w-4 h-4 text-vw-gold" />
                <h3 className="text-sm font-semibold text-white">Import</h3>
            </div>
            <p className="text-xs text-vw-console-text-secondary mb-4">
                Proton Pass (.json) · Bitwarden · Chrome · LastPass · 1Password (.csv).
                Parsed on this device — the file is never uploaded.
            </p>

            <input
                ref={fileInput}
                type="file"
                accept=".json,.csv,.tsv,.txt"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                className="block w-full text-xs text-vw-console-text-secondary file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-vw-gold file:text-vw-console-bg hover:file:bg-[#C69431] file:cursor-pointer"
            />

            {error && (
                <div className="flex items-start gap-2 mt-3 px-3 py-2 rounded-lg border border-vw-signal-alert/40 bg-vw-signal-alert/10 text-xs text-vw-signal-alert">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}

            {imported !== null && (
                <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-vw-signal-online/40 bg-vw-signal-online/10 text-xs text-vw-signal-online">
                    <Check className="w-4 h-4 flex-shrink-0" />
                    <span>Imported {imported} {imported === 1 ? 'item' : 'items'}.</span>
                </div>
            )}

            {parsed && (
                <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-xs text-vw-console-text-secondary">
                            <FileText className="w-3.5 h-3.5" />
                            <span>
                                {parsed.sourceLabel} — {candidates.length} found, {selected.size} selected
                            </span>
                        </div>
                        <button onClick={reset} className="text-vw-console-text-secondary hover:text-white">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex items-center gap-3 mb-2 text-[11px]">
                        <button
                            onClick={() => setSelected(new Set(candidates.map((_, i) => i)))}
                            className="text-vw-gold hover:underline"
                        >
                            Select all
                        </button>
                        <button
                            onClick={() => setSelected(new Set())}
                            className="text-vw-console-text-secondary hover:text-white"
                        >
                            Select none
                        </button>
                        <button
                            onClick={() => setSelected(new Set(candidates.map((c, i) => (c.duplicateOfId ? -1 : i)).filter(i => i >= 0)))}
                            className="text-vw-console-text-secondary hover:text-white"
                        >
                            Skip duplicates
                        </button>
                    </div>

                    <div className="max-h-64 overflow-y-auto border border-vw-console-border rounded-lg divide-y divide-vw-console-border">
                        {candidates.map((candidate, index) => (
                            <label
                                key={index}
                                className="flex items-center gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-vw-console-surface"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.has(index)}
                                    onChange={() => toggle(index)}
                                    className="accent-vw-gold flex-shrink-0"
                                />
                                <span className="flex-1 min-w-0">
                                    <span className="block text-white truncate">{candidate.metadata.label}</span>
                                    <span className="block text-vw-console-text-secondary truncate">{describe(candidate)}</span>
                                </span>
                                {candidate.duplicateOfId && (
                                    <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-vw-signal-warning border border-vw-signal-warning/40 rounded-full px-2 py-0.5">
                                        Already saved
                                    </span>
                                )}
                            </label>
                        ))}
                    </div>

                    {parsed.skipped.length > 0 && (
                        <details className="mt-2">
                            <summary className="text-[11px] text-vw-console-text-secondary cursor-pointer hover:text-white">
                                {parsed.skipped.length} row{parsed.skipped.length === 1 ? '' : 's'} could not be imported
                            </summary>
                            <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                                {parsed.skipped.map((skip, i) => (
                                    <li key={i} className="text-[10px] text-vw-console-text-secondary/70">
                                        {skip.detail ? `${skip.detail} — ` : ''}{skip.reason}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}

                    <button
                        onClick={commit}
                        disabled={busy || selected.size === 0}
                        className="w-full mt-3 py-2.5 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431] disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {busy
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing {progress.done}/{progress.total}…</>
                            : <>Import {selected.size} {selected.size === 1 ? 'item' : 'items'}</>}
                    </button>
                </div>
            )}
        </div>
    );
}
