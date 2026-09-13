import { useState, useEffect } from 'react';
import { titles } from '@/data/titles';
import { genres } from '@/data/genres';
import type { Title, Genre } from '@/data/types';

export function useTitles(options?: { publishedOnly?: boolean }) {
  const [titleList, setTitleList] = useState<Title[]>([]);
  const [genreList, setGenreList] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const publishedOnly = options?.publishedOnly ?? true;

  const refetch = async () => {
    setLoading(true);
    try {
      const [fetchedTitles, fetchedGenres] = await Promise.all([
        publishedOnly ? titles.listPublished() : titles.listAll(),
        genres.list(),
      ]);
      setTitleList(fetchedTitles);
      setGenreList(fetchedGenres);
      setError(null);
    } catch (err: any) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refetch();
  }, [publishedOnly]);

  return { titles: titleList, genres: genreList, loading, error, refetch };
}
