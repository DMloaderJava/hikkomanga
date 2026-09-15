import { useState, useEffect } from 'react';
import type { Genre } from '@/data/types';
import { genres as genresApi } from '@/data/genres';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tag, Plus, Edit2, Trash2, Check, X, AlertTriangle } from 'lucide-react';

export function GenreManager() {
  const [genreList, setGenreList] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New genre state
  const [newGenreName, setNewGenreName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // Delete dialog state
  const [deleteConfirmGenre, setDeleteConfirmGenre] = useState<Genre | null>(null);
  const [usageCount, setUsageCount] = useState<number>(0);

  const loadGenres = async () => {
    setLoading(true);
    try {
      const data = await genresApi.list();
      setGenreList(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки жанров');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGenres();
  }, []);

  const handleCreate = async () => {
    if (!newGenreName.trim()) return;
    setIsCreating(true);
    try {
      await genresApi.create(newGenreName.trim());
      setNewGenreName('');
      await loadGenres();
    } catch (err: any) {
      setError(err.message || 'Не удалось создать жанр');
    } finally {
      setIsCreating(false);
    }
  };

  const handleStartEdit = (genre: Genre) => {
    setEditingId(genre.id);
    setEditName(genre.name);
  };

  const handleSaveEdit = async (id: string) => {
    if (!editName.trim()) return;
    try {
      await genresApi.update(id, editName.trim());
      setEditingId(null);
      await loadGenres();
    } catch (err: any) {
      setError(err.message || 'Не удалось обновить жанр');
    }
  };

  const handlePromptDelete = async (genre: Genre) => {
    const count = await genresApi.getUsageCount(genre.id);
    setUsageCount(count);
    setDeleteConfirmGenre(genre);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmGenre) return;
    try {
      await genresApi.delete(deleteConfirmGenre.id);
      setDeleteConfirmGenre(null);
      await loadGenres();
    } catch (err: any) {
      setError(err.message || 'Не удалось удалить жанр');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Header + Add Form */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/80 p-6">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Tag className="h-5 w-5 text-rose-500" /> Управление жанрами
          </h2>
          <p className="text-xs text-neutral-400 mt-1">
            Добавляйте и редактируйте жанры для каталога
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="Название жанра..."
            value={newGenreName}
            onChange={(e) => setNewGenreName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="w-48 text-sm"
          />
          <Button
            onClick={handleCreate}
            disabled={isCreating || !newGenreName.trim()}
            className="gap-1.5 shrink-0"
          >
            <Plus className="h-4 w-4" /> Добавить
          </Button>
        </div>
      </div>

      {/* Genres Table */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden shadow-xl">
        {loading ? (
          <div className="p-12 text-center text-sm text-neutral-500">Загрузка жанров...</div>
        ) : genreList.length === 0 ? (
          <div className="p-12 text-center text-sm text-neutral-500">Жанров пока нет</div>
        ) : (
          <table className="w-full text-left text-sm text-neutral-200">
            <thead className="bg-neutral-950/80 text-xs uppercase font-semibold text-neutral-400 border-b border-neutral-800">
              <tr>
                <th className="px-6 py-4">Название</th>
                <th className="px-6 py-4 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {genreList.map((genre) => (
                <tr key={genre.id} className="hover:bg-neutral-800/40 transition-colors">
                  <td className="px-6 py-4">
                    {editingId === genre.id ? (
                      <div className="flex items-center gap-2 max-w-xs">
                        <Input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-8 text-xs"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => handleSaveEdit(genre.id)}
                          className="h-8 w-8 p-0"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                          className="h-8 w-8 p-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="font-semibold text-white">{genre.name}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStartEdit(genre)}
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-white"
                        title="Редактировать"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handlePromptDelete(genre)}
                        className="h-8 w-8 p-0 text-neutral-400 hover:text-red-400 hover:bg-red-950/40"
                        title="Удалить"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteConfirmGenre}
        onOpenChange={(open) => !open && setDeleteConfirmGenre(null)}
      >
        <DialogContent className="max-w-md">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-950/60 text-amber-500">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1.5 pr-6">
                <DialogTitle className="text-lg font-bold text-white">
                  Удаление жанра
                </DialogTitle>
                <DialogDescription className="text-sm text-neutral-300">
                  Вы уверены, что хотите удалить жанр{' '}
                  <strong className="text-white">«{deleteConfirmGenre?.name}»</strong>?
                </DialogDescription>
              </div>
            </div>

            {usageCount > 0 && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-3 text-xs text-amber-300">
                Этот жанр сейчас используется в {usageCount} тайтлах. При удалении он будет автоматически отвязан от них.
              </div>
            )}

            <div className="flex justify-end gap-3 pt-1">
              <Button variant="outline" size="sm" onClick={() => setDeleteConfirmGenre(null)}>
                Отмена
              </Button>
              <Button variant="destructive" size="sm" onClick={handleConfirmDelete}>
                Да, удалить
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
