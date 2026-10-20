import React from 'react';
import { Minus, Plus } from 'lucide-react';
import { SEARCH_TILE_SIZE_MIN, SEARCH_TILE_SIZE_MAX, SEARCH_TILE_SIZE_STEP } from '../../features/search-workspace/tileSize';

const SearchTileSizeControlView: React.FC<{ tileSize: number; setTileSize: (size: number) => void }> = ({ tileSize, setTileSize }) => {

  return (
    <div className="search-tile-size-control" role="group" aria-label="Tile size">
      <span className="search-tile-size-label" aria-hidden="true">Size</span>
      <button
        type="button"
        aria-label="Decrease tile size"
        title="Smaller tiles"
        disabled={tileSize <= SEARCH_TILE_SIZE_MIN}
        onClick={() => setTileSize(tileSize - SEARCH_TILE_SIZE_STEP)}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <output
        className="search-tile-size-value"
        aria-label="Current tile size"
        aria-live="polite"
      >
        {tileSize}px
      </output>
      <button
        type="button"
        aria-label="Increase tile size"
        title="Larger tiles"
        disabled={tileSize >= SEARCH_TILE_SIZE_MAX}
        onClick={() => setTileSize(tileSize + SEARCH_TILE_SIZE_STEP)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
};

export default SearchTileSizeControlView;
