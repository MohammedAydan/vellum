import { describe, expect, it } from 'vitest';
import { compileQueryToParameterizedSql, validateAndNormalizeQuery } from '../index.js';

describe('typed unindexed numeric ordering', () => {
  for (const dir of ['asc','desc'] as const) {
    it(`uses numeric JSONB keys for ${dir} sort and cursor seek`, () => {
      const query = validateAndNormalizeQuery({collectionPath:'scores',orderBy:[{field:'rank',dir}],limit:7});
      const compiled = compileQueryToParameterizedSql({projectId:'123e4567-e89b-12d3-a456-426614174000',normalizedQuery:query,cursor:{qHash:'h', vals:[10],docId:'ten'},cursorMode:'startAfter'});
      expect(compiled.sql).toContain("jsonb_typeof((d.data #>");
      expect(compiled.sql).toContain("= 'number' THEN jsonb_build_array(3,");
      expect(compiled.sql).toContain("->> '$t' = 'int'");
      expect(compiled.sql).toContain('::numeric');
      expect(compiled.params).toContain('10');
      expect(compiled.sql).not.toContain('COLLATE "C"');
    });
  }
});
