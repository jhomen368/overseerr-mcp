# Comprehensive Test Plan: Media Management Workflow

**Version**: 1.2.1  
**Scope**: Complete workflow covering **anime (priority)**, TV shows, movies, mixed batches, deduplication, availability checking, and request management  
**Objective**: Exhaustive edge case testing across all media types to identify bugs and ensure reliability  
**Test Count**: 82+ scenarios across 13 categories

**⚠️ MANDATORY EXECUTION**: ALL 13 categories MUST be run in every test execution. No categories may be skipped.

---

## Test Environment Setup

### Prerequisites
- Overseerr instance with test data
- API access configured (OVERSEERR_URL and OVERSEERR_API_KEY environment variables)
- Multiple test scenarios with:
  - **Anime** (seasonal anime, multiple seasons, special characters) - PRIMARY FOCUS
  - **TV shows** (American/British/international series)
  - **Movies** (various genres, years, special characters)
  - **Mixed batches** (anime + movies + TV shows together)
  - Available media (status 5)
  - Requested media (various statuses)
  - Unrequested media
  - Special character titles
  - Duplicate/similar titles

### Test Data Requirements
Create or ensure the following exist:

**Anime (Priority)**:
1. **Anime series with multiple seasons** (e.g., My Hero Academia S1-S7, Attack on Titan)
2. **Anime with "Part" naming** (Attack on Titan Part 1, Part 2)
3. **Anime with "Cour" naming** (Re:Zero Cour 1, Cour 2)
4. **Anime with Roman numerals** (Overlord IV, Mob Psycho 100 III)
5. **Anime with special characters** (KonoSuba: God's Blessing on This Wonderful World!)

**TV Shows**:
6. **TV series with multiple seasons** (Breaking Bad S1-S5, Game of Thrones S1-S8)
7. **TV shows with partial availability** (House of the Dragon - some seasons)
8. **TV shows with season 0 (specials)** (The Mandalorian, Stranger Things)

**Movies**:
9. **Classic movies** (The Shawshank Redemption, The Godfather)
10. **Recent releases** (Oppenheimer (2023), Barbie (2023))
11. **Movies with special characters** (Ocean's Eleven, Mamma Mia!)

**Mixed & Edge Cases**:
12. **Mixed batches** (combination of anime, TV shows, and movies)
13. **Titles with year suffixes** (Dune (2021), The Batman (2022))
14. **Partially available series** (some seasons available, some not)
15. **Completely available series**
16. **Requested but not available series**
17. **Mixed request states** (some seasons requested, others not)

---

## Test Categories

**⚠️ ALL 12 CATEGORIES ARE MANDATORY IN EVERY TEST RUN**

### Category 1: Title Normalization & Season Extraction (9 tests)

#### Test 1.1: Basic Season Normalization
**Input**: `["My Hero Academia Season 7", "Demon Slayer: Kimetsu no Yaiba S4"]`  
**Expected**:
- Normalized to base titles: "My Hero Academia", "Demon Slayer: Kimetsu no Yaiba"
- Season numbers extracted: 7, 4
- API searches for base titles

**Edge Cases**:
- Verify season number preservation in response
- Check franchiseInfo includes season context

#### Test 1.2: Roman Numeral Season Indicators
**Input**: `["Mob Psycho 100 III", "Overlord IV"]`  
**Expected**:
- "Mob Psycho 100 III" → normalize to "Mob Psycho 100", extract season 3
- "Overlord IV" → normalize to "Overlord", extract season 4
- Integral number "100" preserved in Mob Psycho 100

**Edge Cases**:
- Test Roman numerals I through XV
- Ensure "100" is not mistaken for Roman numeral

#### Test 1.3: Part/Cour Naming
**Input**: `["Attack on Titan Part 1", "Re:Zero Cour 2"]`  
**Expected**:
- Both normalize correctly
- Part/Cour numbers extracted as season equivalents

#### Test 1.4: Year Suffix Removal
**Input**: `["Frieren: Beyond Journey's End (2024)"]`  
**Expected**:
- Year removed from search
- Title normalizes correctly
- No impact on search results

#### Test 1.5: Mixed Formats
**Input**: `["Series S2", "Series Season 2", "Series 2nd Season", "Series II"]`  
**Expected**:
- All normalize to "Series"
- All extract season 2
- All treated as same base series

#### Test 1.6: Final Season Variants
**Input**: `["Attack on Titan Final Season", "Attack on Titan The Final Season"]`  
**Expected**:
- Both normalize to base title
- Dedupe recognizes as same series
- No false duplicates

#### Test 1.7: Integral Numbers Preservation
**Input**: `["Mob Psycho 100", "86: Eighty-Six", "Code:Breaker 06"]`  
**Expected**:
- Numbers preserved in search
- Not confused with season numbers
- Correct matching

#### Test 1.8: No Normalization Without Flag
**Input**: `{titles: ["Series Season 2"], autoNormalize: false}`  
**Expected**:
- Searches for exact string "Series Season 2"
- No title normalization
- Different results vs normalized search

#### Test 1.9: Season Validation (Bug #18 Fix)
**Input**: `["Attack on Titan Season 10", "Overlord Season 15"]`  
**Expected**:
- Normalized titles match correct series
- System fetches series details to check numberOfSeasons
- Season 10 > Attack on Titan's total seasons → tries alternates
- Season 15 > Overlord's total seasons → tries alternates
- If no valid match found: reasonCode "NOT_FOUND" with note about season not existing
- Prevents requesting impossible season numbers

**Edge Cases**:
- Series with exactly matching season count (e.g., "Series Season 5" for 5-season show)
- Series with one season less (boundary test)
- Series name that might have sequel with that season
- Validate alternate selection if primary match insufficient

**Bug #18 Context**: 
- Previous behavior: Would accept any season number without validation
- Fixed behavior: Validates season number against series.numberOfSeasons
- Falls back to alternates if primary match doesn't have enough seasons
- Returns NOT_FOUND if no match has the requested season

---

### Category 2: Deduplication Logic (9 tests)

#### Test 2.1: NOT_FOUND Status
**Input**: `["Nonexistent Anime Title XYZABC123"]`  
**Expected**:
```json
{
  "status": "pass",
  "reasonCode": "NOT_FOUND",
  "isActionable": false,
  "note": "Not found in TMDB"
}
```

#### Test 2.2: ALREADY_AVAILABLE - Complete Series
**Input**: Title with all seasons available (status 5)  
**Expected**:
```json
{
  "status": "blocked",
  "reasonCode": "ALREADY_AVAILABLE",
  "isActionable": false,
  "reason": "Already available in library"
}
```

#### Test 2.3: ALREADY_AVAILABLE - All Regular Seasons
**Setup**: TV show with seasons 0-5, only 1-5 available (season 0 is specials)  
**Expected**:
- Treated as fully available
- Season 0 (specials) excluded from check
- reasonCode: ALREADY_AVAILABLE

#### Test 2.4: SEASON_AVAILABLE - Specific Season Check
**Input**: `["My Hero Academia Season 5"]` where S5 is available  
**Expected**:
```json
{
  "status": "blocked",
  "reasonCode": "SEASON_AVAILABLE",
  "isActionable": false,
  "franchiseInfo": "Series: My Hero Academia | Season 5 is available"
}
```

#### Test 2.5: ALREADY_REQUESTED - Any Season
**Setup**: Series with at least one season requested  
**Input**: Base title without season number  
**Expected**:
- status: blocked
- reasonCode: ALREADY_REQUESTED
- franchiseInfo shows which seasons requested

#### Test 2.6: SEASON_REQUESTED - Specific Season
**Input**: `["Series Season 3"]` where S3 is requested but not available  
**Expected**:
```json
{
  "status": "blocked",
  "reasonCode": "SEASON_REQUESTED",
  "isActionable": false,
  "franchiseInfo": "All requested seasons: 1, 2, 3"
}
```

#### Test 2.7: AVAILABLE_FOR_REQUEST - Clean Slate
**Input**: Series never requested, not in library  
**Expected**:
```json
{
  "status": "pass",
  "reasonCode": "AVAILABLE_FOR_REQUEST",
  "isActionable": true
}
```

#### Test 2.8: AVAILABLE_FOR_REQUEST - Specific Season with Others Requested
**Setup**: S1-3 requested, checking S4  
**Input**: `["Series Season 4"]`  
**Expected**:
- status: pass
- reasonCode: AVAILABLE_FOR_REQUEST
- isActionable: true
- note mentions other seasons in library

#### Test 2.9: Media Status vs Request Status
**Setup**: Series with mediaInfo.status = 3 (PROCESSING) and active request  
**Expected**:
- Should still be blocked as ALREADY_REQUESTED
- Status not conflated with availability

---

### Category 3: Batch Operations & Performance (6 tests)

#### Test 3.1: Large Batch (50 titles)
**Input**: 50 distinct anime titles  
**Expected**:
- All processed without timeout
- Results match individual queries
- Execution time < 30 seconds
- Summary statistics accurate

#### Test 3.2: Very Large Batch (100 titles)
**Input**: 100 titles (stress test)  
**Expected**:
- Completes successfully
- No memory issues
- Cache utilized effectively
- Results remain accurate

#### Test 3.3: Batch with Failures
**Input**: Mix of valid and invalid titles  
**Expected**:
- Successful items processed
- Failed items reported separately
- No cascading failures
- Summary shows correct counts

#### Test 3.4: Duplicate Titles in Batch
**Input**: `["Title A", "Title A", "Title B"]`  
**Expected**:
- All three processed (no early deduplication)
- Results may be identical for duplicates
- Cache hit for second "Title A"

#### Test 3.5: Cache Hit Rate on Repeated Batch
**Test**:
1. Run dedupe with 20 titles
2. Immediately run same 20 titles again
**Expected**:
- Second run ~20x faster
- Cache hit rate ~100%
- Identical results

#### Test 3.6: Mixed Language Batch
**Input**: Titles in multiple languages (English, Japanese, Korean)  
**Expected**:
- All languages processed correctly
- UTF-8 encoding handled
- No character corruption

---

### Category 4: includeDetails Enrichment (5 tests)

#### Test 4.1: Basic Field Enrichment
**Input**:
```json
{
  "dedupeMode": true,
  "titles": ["Frieren"],
  "includeDetails": {
    "fields": ["rating", "overview", "year"]
  }
}
```
**Expected**:
- Details object present in response
- Only requested fields included
- Values accurate

#### Test 4.2: TV-Specific Fields
**Input**:
```json
{
  "includeDetails": {
    "fields": ["numberOfSeasons", "seasons"]
  }
}
```
**Expected**:
- Seasons array with availability status
- Each season includes status (AVAILABLE, REQUESTED, NOT_REQUESTED, PROCESSING)
- Episode counts present

#### Test 4.3: targetSeason Auto-Addition
**Input**: `["My Hero Academia Season 7"]` with `seasons` field requested  
**Expected**:
- targetSeason auto-added to details
- Contains season 7 specific data
- Includes availability status for S7

#### Test 4.4: Disable targetSeason Auto-Addition
**Input**:
```json
{
  "includeDetails": {
    "fields": ["seasons"],
    "includeSeason": false
  }
}
```
**Expected**:
- targetSeason NOT added even for season-specific titles
- Only full seasons array returned

#### Test 4.5: All Available Fields
**Input**: All documented field types  
**Expected**:
- Basic fields (mediaType, year, posterPath)
- Standard fields (rating, overview, genres, runtime)
- TV-specific (numberOfSeasons, numberOfEpisodes, seasons)
- Advanced (releaseDate, originalTitle, popularity, etc.)
- Availability (mediaStatus, hasRequests, requestCount)

---

### Category 5: Auto-Request Workflow (5 tests)

#### Test 5.1: autoRequest with Dry Run
**Input**:
```json
{
  "dedupeMode": true,
  "autoRequest": true,
  "titles": ["Available Title"],
  "requestOptions": {
    "dryRun": true
  }
}
```
**Expected**:
- Preview of what would be requested
- No actual requests made
- Clear indication it's a dry run

#### Test 5.2: autoRequest Only Actionable Items
**Input**: Mix of pass (actionable) and blocked items  
**Expected**:
- Only isActionable: true items queued
- Blocked items skipped
- Summary shows skipped count

#### Test 5.3: autoRequest with Specific Seasons
**Input**:
```json
{
  "autoRequest": true,
  "requestOptions": {
    "seasons": [1, 2, 3]
  }
}
```
**Expected**:
- TV shows requested with specified seasons
- Movies requested normally (seasons ignored)

#### Test 5.4: autoRequest Extracts Season from Title
**Input**: `["Series Season 5"]` with autoRequest  
**Expected**:
- Only Season 5 requested (not all seasons)
- Season extracted from title
- Correct in autoRequests result

#### Test 5.5: autoRequest Failure Handling
**Setup**: Some titles will fail to request (validation errors)  
**Expected**:
- Successful requests completed
- Failed requests reported with errors
- No rollback of successful requests

---

### Category 6: Request Validation & Confirmation (4 tests)

#### Test 6.1: validateFirst Prevents Duplicate
**Setup**: Already requested media  
**Input**: `request_media` with `validateFirst: true`  
**Expected**:
- Request rejected before API call
- Returns ALREADY_REQUESTED status
- Shows existing request details

#### Test 6.2: Multi-Season Confirmation Required
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 12345,
  "seasons": "all"
}
```
**Expected**:
- First response requires confirmation
- Shows season count and episode count
- Provides confirmWith object

#### Test 6.3: Multi-Season Confirmation Bypass
**Input**: Same as 6.2 but with `confirmed: true`  
**Expected**:
- Request proceeds immediately
- No confirmation step
- All seasons requested

#### Test 6.4: Single Season No Confirmation
**Input**: Request with seasons: [3]  
**Expected**:
- No confirmation required
- Request proceeds immediately

#### Test 6.5: Episode Threshold Check (< 24 episodes)
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 12345,
  "seasons": [1, 2]
}
```
**Setup**: Show with 2 seasons, total 20 episodes (10 each)  
**Expected**:
- No confirmation required (below 24 episode threshold)
- Request proceeds immediately
- Episodes: 20 <= 24

#### Test 6.6: Episode Threshold Check (> 24 episodes)
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 67890,
  "seasons": [1, 2, 3]
}
```
**Setup**: Show with 3 seasons, total 36 episodes (12 each)  
**Expected**:
- Confirmation required (exceeds 24 episode threshold)
- Response shows threshold value (24)
- Response shows requesting 36 episodes
- Clear message about confirmation needed

#### Test 6.4: Single Season No Confirmation
**Input**: Request with seasons: [3]  
**Expected**:
- No confirmation required
- Request proceeds immediately

---

### Category 7: Edge Cases & Error Handling (5 tests)

#### Test 7.1: Special Characters in Titles
**Input**: Titles with `!`, `'`, `"`, `*`, `(`, `)`, `&`, `%`  
**Expected**:
- All characters properly URL-encoded
- No HTTP 400 errors
- Correct search results

#### Test 7.2: Empty/Null Inputs
**Input**: Empty titles array, null values  
**Expected**:
- Graceful error handling
- Clear error messages
- No server crashes

#### Test 7.3: Very Long Titles
**Input**: Title with 200+ characters  
**Expected**:
- Handled without truncation
- API accepts request
- Results returned correctly

#### Test 7.4: Concurrent Batch Requests
**Test**: Launch 3 simultaneous 30-title batches  
**Expected**:
- All complete successfully
- No race conditions
- Cache remains consistent
- No duplicate API calls

#### Test 7.5: Cache Invalidation on Request
**Test**:
1. Search for title (cached)
2. Request that title
3. Search again
**Expected**:
- Step 3 fetches fresh data (cache invalidated)
- New media status reflected
- No stale data served

---

### Category 8: Integration & Workflow (3 tests)

#### Test 8.1: Complete Pass 1 → Pass 2 Workflow
**Steps**:
1. Dedupe 50 titles with includeDetails
2. Filter actionable items
3. Run autoRequest with filtered list
**Expected**:
- Smooth handoff between passes
- Data consistency maintained
- All actionable items requested

#### Test 8.2: Mixed Media Type Batch
**Input**: Movies and TV shows in same batch  
**Expected**:
- Both handled correctly
- TV show logic for TV shows
- Movie logic for movies
- No type confusion

#### Test 8.3: Preference Profile Application
**Input**: Request with custom serverId, profileId, rootFolder  
**Expected**:
- Options passed to API correctly
- Request routed to correct server
- Profile settings applied

---

### Category 9: Movies & TV Shows (Non-Anime) (8 tests)

#### Test 9.1: Classic Movies - Already Available
**Input**: `["The Shawshank Redemption", "The Godfather", "The Dark Knight"]`  
**Expected**:
- All identified as movies
- All marked ALREADY_AVAILABLE
- Correct TMDB IDs returned

#### Test 9.2: Recent Movie Releases with Year Suffix
**Input**: `["Oppenheimer (2023)", "Barbie (2023)", "Dune (2021)"]`  
**Expected**:
- Year suffixes removed from search
- Movies found correctly
- Year preserved in details if requested

#### Test 9.3: TV Shows with Multiple Seasons
**Input**: `["Breaking Bad Season 5", "Game of Thrones Season 8", "The Office Season 9"]`  
**Expected**:
- Season normalization working
- Specific season status checked
- Franchise info shows season context

#### Test 9.4: TV Shows - Complete Series Check
**Input**: `["The Last of Us", "The Mandalorian", "Stranger Things"]`  
**Expected**:
- Season 0 (specials) excluded from count
- All regular seasons checked
- Partial availability detected

#### Test 9.5: Movies with Special Characters - Apostrophes
**Input**: `["Ocean's Eleven", "The Queen's Gambit", "Don't Look Up"]`  
**Expected**:
- No HTTP 400 errors
- Apostrophes encoded as %27
- All titles found successfully

#### Test 9.6: Movies with Special Characters - Exclamation Marks
**Input**: `["Mamma Mia!", "Airplane!", "Oklahoma!"]`  
**Expected**:
- No HTTP 400 errors
- Exclamation marks encoded as %21
- All titles found successfully

#### Test 9.7: TV Shows - Season-Specific Queries
**Input**: `["Stranger Things Season 4", "House of the Dragon Season 2", "The Bear Season 2"]`  
**Expected**:
- targetSeason data included if fields requested
- Specific season availability checked
- Enhanced franchise info

#### Test 9.8: Mixed TV Show States
**Input**: Mix of available, requested, and actionable TV shows  
**Expected**:
- Each show evaluated independently
- Correct reasonCode for each
- Summary statistics accurate

---

### Category 10: Mixed Media Batches (6 tests)

#### Test 10.1: Anime + Movies Mixed Batch
**Input**: 10 anime titles + 10 movie titles in single batch  
**Expected**:
- All 20 items processed
- Anime handled with normalization
- Movies identified correctly
- No type confusion

#### Test 10.2: Anime + TV Shows Mixed Batch
**Input**: 10 anime titles + 10 TV show titles  
**Expected**:
- Both types handled correctly
- Season detection works for both
- Franchise info appropriate for each
- Performance maintained

#### Test 10.3: Movies + TV Shows Mixed Batch
**Input**: 10 movies + 10 TV shows with season numbers  
**Expected**:
- TV shows: season-specific checks
- Movies: simple availability check
- No cross-contamination
- Summary shows both types

#### Test 10.4: Three-Way Mixed Batch
**Input**: 10 anime + 5 movies + 10 TV shows  
**Expected**:
- All 25 items processed independently
- Correct media type for each
- Appropriate logic applied per type
- Execution time < 5 seconds

#### Test 10.5: Mixed Batch with Failures
**Input**: Valid anime + invalid titles + valid movies  
**Expected**:
- Valid items processed successfully
- Invalid items return NOT_FOUND
- No cascading failures
- Mixed types in success/failure groups

#### Test 10.6: Large Mixed Batch (50 items)
**Input**: 20 anime + 15 movies + 15 TV shows  
**Expected**:
- All processed without timeout
- Cache effectiveness maintained
- Memory usage within limits
- Accurate summary statistics

---

### Category 11: Media Type Detection (5 tests)

#### Test 11.1: Anime TV vs Movie Disambiguation
**Input**: Anime titles that have both TV series and movies  
**Expected**:
- TV series prioritized for season queries
- Base titles return correct primary type
- Confidence scoring accurate
- Low confidence logged

#### Test 11.2: TV Show Season Detection
**Input**: TV show titles with explicit season numbers  
**Expected**:
- inferExpectedMediaType returns 'tv'
- selectBestMatch filters for TV results
- Movie results rejected
- Confidence: high

#### Test 11.3: Movie Type Consistency
**Input**: Pure movie titles without season indicators  
**Expected**:
- inferExpectedMediaType returns 'any'
- Movie results accepted
- mediaType: "movie" in response
- No false TV matches

#### Test 11.4: Ambiguous Titles
**Input**: Titles that could be either TV or movie  
**Expected**:
- First valid result accepted
- Confidence: medium or low
- Warning logged if confidence low
- mediaType clearly indicated

#### Test 11.5: NOT_FOUND Media Type
**Input**: Non-existent titles  
**Expected**:
- mediaType: undefined (field omitted)
- reasonCode: NOT_FOUND
- isActionable: false
- Consistent across all NOT_FOUND items

---

### Category 12: Real-World Scenarios (5 tests)

#### Test 12.1: Seasonal Anime Workflow (Primary Use Case)
**Steps**:
1. User provides 50 seasonal anime titles
2. Run dedupe with autoNormalize
3. Filter actionable items
4. Review franchiseInfo for context
**Expected**:
- 40-45 items processed successfully
- 5-10 identified as NOT_FOUND
- Actionable items have clear seasonNumber
- Enhanced franchise info shows availability

#### Test 12.2: Movie Collection Check
**Steps**:
1. User provides 30 classic movies
2. Run dedupe to check availability
3. Review which are available vs actionable
**Expected**:
- Most classics already available
- Few actionable (unrequested)
- mediaType: "movie" for all
- Fast execution (< 3 seconds)

#### Test 12.3: TV Show Season Backlog
**Steps**:
1. User provides 25 TV show season-specific queries
2. Mix of Season 1, 2, 3, etc. from various shows
3. Run dedupe with includeDetails
**Expected**:
- targetSeason auto-added for each
- Partial availability detected
- Some seasons available, others not
- Clear actionable list for requesting

#### Test 12.4: Mixed Update Batch
**Steps**:
1. User checks 40 titles: 15 anime + 15 movies + 10 TV shows
2. Some already in library, some requested, some new
3. Run dedupe to get current status
**Expected**:
- All types handled correctly
- Accurate status for each
- Summary shows breakdown by type
- No type confusion

#### Test 12.5: Special Characters Stress Test
**Steps**:
1. User provides 20 titles with various special characters
2. Mix of !, ', ", &, %, (, ), *
3. Combination of anime, movies, TV shows
**Expected**:
- Zero HTTP 400/500 errors
- All special chars encoded properly
- 100% success rate
- All titles found or NOT_FOUND correctly

---

### Category 13: Bug #19 - TV Seasons Parameter Validation (6 tests)

**Bug Context (v1.2.1)**:
- **Issue**: TV show requests without seasons parameter causing HTTP 500 errors
- **Root Cause**: Overseerr API error: "Cannot read properties of undefined (reading 'filter')"
- **Fix**: Added validation to require seasons parameter for all TV show requests
- **Location**: [`src/index.ts`](src/index.ts:1444-1449) (handleSingleRequest validation)
- **Impact**: Prevents API errors, provides clear user feedback

#### Test 13.1: TV Show Without Seasons Parameter - Direct Request
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 82856,
  "dryRun": true
}
```
**Expected**:
- Request REJECTED with error
- Error message: "seasons parameter is required for TV show requests"
- Suggests valid formats: `seasons: [1,2,3]` or `seasons: "all"`
- No HTTP 500 error propagated to Overseerr API
- Validation occurs immediately (no API call made)

#### Test 13.2: TV Show With Seasons Array - Direct Request
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 82856,
  "seasons": [1, 2],
  "dryRun": true
}
```
**Expected**:
- Request ACCEPTED
- Dry run preview shows: `"seasons": [1, 2]`
- mediaType: "tv"
- Valid request structure ready for API

#### Test 13.3: TV Show With seasons="all" - Direct Request
**Input**:
```json
{
  "mediaType": "tv",
  "mediaId": 82856,
  "seasons": "all",
  "dryRun": true
}
```
**Expected**:
- Request ACCEPTED
- Dry run preview shows: `"seasons": "all"`
- Valid for requesting all available seasons

#### Test 13.4: Movie Without Seasons Parameter
**Input**:
```json
{
  "mediaType": "movie",
  "mediaId": 438631,
  "dryRun": true
}
```
**Expected**:
- Request ACCEPTED (movies don't require seasons)
- No seasons field in response
- mediaType: "movie"
- Validation distinguishes between TV and movie

#### Test 13.5: Auto-Request Workflow - Season Extraction and Default
**Input**:
```json
{
  "dedupeMode": true,
  "autoRequest": true,
  "titles": ["The Bear Season 1", "Breaking Bad", "Dune"],
  "autoNormalize": true,
  "requestOptions": {
    "dryRun": true
  }
}
```
**Expected**:
- TV with season in title: Extracts season number → seasons: [1]
- TV without season: Defaults to seasons: "all"
- Movie: No seasons parameter
- All items queued correctly per media type
- Auto-request workflow handles TV vs movie distinction

**Edge Cases**:
- Season extraction from "Season N", "S N", "Part N" patterns
- Default "all" when no season specified for TV
- requestOptions.seasons overrides default

#### Test 13.6: Batch Request - Mixed Media with Missing TV Seasons
**Input**:
```json
{
  "items": [
    { "mediaType": "movie", "mediaId": 438631 },
    { "mediaType": "tv", "mediaId": 94997 },
    { "mediaType": "tv", "mediaId": 82856, "seasons": [1] }
  ],
  "dryRun": true
}
```
**Expected**:
- Item 1 (movie): SUCCEEDS
- Item 2 (TV without seasons): FAILS with clear error
- Item 3 (TV with seasons): SUCCEEDS
- Batch continues processing despite failure
- Error array identifies which item failed
- No cascading failures
- Summary shows: successful: 2, failed: 1

**Regression Prevention**:
- Prevents future HTTP 500 errors from missing seasons
- Validates at MCP layer before reaching Overseerr API
- Clear error guidance for users/AI assistants

---

## Test Execution Guidelines

### Execution Order
1. Run Category 1 first (normalization foundation)
2. Run Category 2 (core dedupe logic)
3. Run Categories 3-4 (performance + enrichment)
4. Run Category 5 with caution (may create actual requests if not dry-run)
5. Run Categories 6-8 (validation + integration)
6. Run Category 9 (movies & TV shows)
7. Run Category 10 (mixed batches)
8. Run Category 11 (media type detection)
9. Run Category 12 (real-world scenarios)
10. Run Category 13 (Bug #19 validation - critical regression test)

### Success Criteria
- **100% pass rate** for Categories 1-2, 11, 13 (critical core functionality + bug fixes)
- **100% pass rate** for Category 9 (movies & TV shows)
- **95% pass rate** for Categories 3-4, 10 (performance + mixed)
- **90% pass rate** for Categories 5-8, 12 (workflows + real-world)

**Document Version**: 1.2.1  
**Last Updated**: 2025-11-15  
**Next Review**: 2026-02-15  
**Total Test Categories**: 13 (ALL MANDATORY)  
**Total Test Scenarios**: 82+