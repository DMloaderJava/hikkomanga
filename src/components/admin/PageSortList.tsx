import { useState, useEffect } from 'react';
import type { Page } from '@/data/types';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, Download, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SortablePageItemProps {
  page: Page;
  index: number;
  onDelete: (id: string) => void;
}

function SortablePageItem({ page, index, onDelete }: SortablePageItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: page.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : 1,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/90 p-3 shadow-sm hover:border-neutral-700 transition-colors"
    >
      <div className="flex items-center gap-3 overflow-hidden">
        {/* Drag handle */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-neutral-500 hover:text-white p-1 rounded hover:bg-neutral-800"
          title="Зажмите и потяните для сортировки"
        >
          <GripVertical className="h-5 w-5" />
        </button>

        {/* Thumbnail */}
        <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-950 border border-neutral-800 flex items-center justify-center">
          {page.image_url ? (
            <img src={page.image_url} alt={`Стр. ${index + 1}`} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-6 w-6 text-neutral-700" />
          )}
        </div>

        {/* Page metadata */}
        <div className="truncate">
          <div className="text-sm font-bold text-white">Страница {index + 1}</div>
          <div className="text-xs text-neutral-500 font-mono">Порядок: {page.page_order}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {page.original_url && (
          <a
            href={page.original_url}
            target="_blank"
            rel="noreferrer"
            download
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800"
            title="Скачать оригинал"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Оригинал</span>
          </a>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDelete(page.id)}
          className="h-8 w-8 p-0 text-neutral-500 hover:bg-red-950/50 hover:text-red-400"
          title="Удалить страницу"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

interface PageSortListProps {
  pages: Page[];
  onReorder: (reorderedPages: Page[]) => void;
  onDeletePage: (id: string) => void;
}

export function PageSortList({ pages, onReorder, onDeletePage }: PageSortListProps) {
  const [items, setItems] = useState<Page[]>(pages);

  useEffect(() => {
    setItems(pages);
  }, [pages]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      const newItems = arrayMove(items, oldIndex, newIndex).map((p, idx) => ({
        ...p,
        page_order: idx + 1,
      }));
      setItems(newItems);
      onReorder(newItems);
    }
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3 text-xs font-medium text-neutral-400">
        <span>Загружено страниц: {items.length}</span>
        <span>Перетаскивайте за иконку слева для смены порядка</span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map((page, index) => (
              <SortablePageItem
                key={page.id}
                page={page}
                index={index}
                onDelete={onDeletePage}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
