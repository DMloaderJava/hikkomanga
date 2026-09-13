import { useState } from 'react';
import type { DialogueLine } from '@/data/gemini';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, MessageSquare } from 'lucide-react';

interface VoiceoverEditorProps {
  lines: DialogueLine[];
  onSaveLines: (lines: DialogueLine[]) => void;
  onGenerate: () => void;
}

export function VoiceoverEditor({ lines, onSaveLines, onGenerate }: VoiceoverEditorProps) {
  const [editingLines, setEditingLines] = useState<DialogueLine[]>(lines);

  const handleLineChange = (index: number, field: 'speaker' | 'text', value: string) => {
    const updated = [...editingLines];
    updated[index] = { ...updated[index], [field]: value };
    setEditingLines(updated);
    onSaveLines(updated);
  };

  const handleAddLine = () => {
    const newLine: DialogueLine = {
      id: `line-${Date.now()}`,
      speaker: 'Narrator',
      text: '',
      pageIndex: 0,
    };
    const updated = [...editingLines, newLine];
    setEditingLines(updated);
    onSaveLines(updated);
  };

  const handleDeleteLine = (index: number) => {
    const updated = editingLines.filter((_, i) => i !== index);
    setEditingLines(updated);
    onSaveLines(updated);
  };

  return (
    <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/80 p-5 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
        <h4 className="text-sm font-bold text-white flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-rose-500" /> Редактирование реплик ({editingLines.length})
        </h4>
        <Button size="sm" variant="outline" onClick={handleAddLine} className="h-8 text-xs gap-1 border-neutral-800">
          <Plus className="h-3.5 w-3.5" /> Добавить реплику
        </Button>
      </div>

      <div className="max-h-96 overflow-y-auto space-y-3 pr-1">
        {editingLines.length === 0 ? (
          <div className="py-8 text-center text-xs text-neutral-500">
            Реплики еще не добавлены. Нажмите «Добавить реплику» или запустите «Анализ страниц».
          </div>
        ) : (
          editingLines.map((line, idx) => (
            <div
              key={line.id || idx}
              className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3"
            >
              <span className="text-xs font-mono text-neutral-500 mt-2 shrink-0">#{idx + 1}</span>

              <div className="w-36 shrink-0">
                <Input
                  value={line.speaker}
                  onChange={(e) => handleLineChange(idx, 'speaker', e.target.value)}
                  placeholder="Персонаж"
                  className="h-8 text-xs font-semibold text-rose-400"
                />
              </div>

              <div className="flex-1">
                <Textarea
                  value={line.text}
                  onChange={(e) => handleLineChange(idx, 'text', e.target.value)}
                  placeholder="Текст реплики..."
                  rows={2}
                  className="text-xs resize-none"
                />
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDeleteLine(idx)}
                className="h-8 w-8 p-0 text-neutral-500 hover:text-red-400 hover:bg-red-950/40 shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="flex justify-end gap-3 pt-3 border-t border-neutral-800">
        <Button onClick={onGenerate} disabled={editingLines.length === 0} className="gap-2 shadow-lg shadow-rose-600/20">
          Озвучить выписанные реплики
        </Button>
      </div>
    </div>
  );
}
