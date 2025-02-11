import {Box, Colors, NonIdealState, Caption, Subheading, Checkbox} from '@dagster-io/ui';
import flatMap from 'lodash/flatMap';
import uniq from 'lodash/uniq';
import * as React from 'react';

import {useStateWithStorage} from '../hooks/useStateWithStorage';

import {AssetValueGraph, AssetValueGraphData} from './AssetValueGraph';
import {AssetEventGroup} from './groupByPartition';

export const AssetMaterializationGraphs: React.FC<{
  groups: AssetEventGroup[];
  xAxis: 'partition' | 'time';
  asSidebarSection?: boolean;
}> = (props) => {
  const [xHover, setXHover] = React.useState<string | number | null>(null);

  const reversed = React.useMemo(() => {
    return [...props.groups].reverse();
  }, [props.groups]);

  const graphDataByMetadataLabel = extractNumericData(reversed, props.xAxis);
  const graphLabels = Object.keys(graphDataByMetadataLabel).slice(0, 20).sort();

  const [collapsedLabels, setCollapsedLabels] = useStateWithStorage(
    'hidden-graphs',
    validateHiddenGraphsState,
  );

  const toggleCollapsed = React.useCallback(
    (label: string) => {
      setCollapsedLabels((current = []) =>
        current.includes(label) ? current.filter((c) => c !== label) : [...current, label],
      );
    },
    [setCollapsedLabels],
  );

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'stretch',
          flexDirection: 'column',
        }}
      >
        {graphLabels.map((label) => (
          <Box
            key={label}
            style={{width: '100%'}}
            border={{side: 'bottom', width: 1, color: Colors.KeylineGray}}
          >
            {props.asSidebarSection ? (
              <Box padding={{horizontal: 24, top: 8}} flex={{justifyContent: 'space-between'}}>
                <Caption style={{fontWeight: 700}}>{label}</Caption>
                <Checkbox
                  format="switch"
                  checked={!collapsedLabels.includes(label)}
                  onChange={() => toggleCollapsed(label)}
                  size="small"
                />
              </Box>
            ) : (
              <Box
                padding={{horizontal: 24, vertical: 16}}
                border={{side: 'bottom', width: 1, color: Colors.KeylineGray}}
                flex={{justifyContent: 'space-between'}}
              >
                <Subheading>{label}</Subheading>
                <Checkbox
                  format="switch"
                  checked={!collapsedLabels.includes(label)}
                  onChange={() => toggleCollapsed(label)}
                  size="small"
                />
              </Box>
            )}
            {!collapsedLabels.includes(label) ? (
              <Box padding={{horizontal: 24, vertical: 16}}>
                <AssetValueGraph
                  label={label}
                  width="100%"
                  data={graphDataByMetadataLabel[label]}
                  xHover={xHover}
                  onHoverX={(x) => x !== xHover && setXHover(x)}
                />
              </Box>
            ) : undefined}
          </Box>
        ))}
      </div>
      {graphLabels.length === 0 ? (
        props.asSidebarSection ? (
          <Box
            margin={{horizontal: 24, vertical: 12}}
            style={{color: Colors.Gray500, fontSize: '0.8rem'}}
          >
            No numeric metadata entries available to be graphed.
          </Box>
        ) : (
          <Box padding={{horizontal: 24, top: 64}}>
            <NonIdealState
              shrinkable
              icon="linear_scale"
              title="No numeric metadata"
              description={`Include numeric metadata entries in your materializations and observations to see data graphed by ${props.xAxis}.`}
            />
          </Box>
        )
      ) : (
        props.xAxis === 'partition' && (
          <Box padding={{vertical: 16, horizontal: 24}} style={{color: Colors.Gray400}}>
            When graphing values by partition, the highest data point for each materialized event
            label is displayed.
          </Box>
        )
      )}
    </>
  );
};

const validateHiddenGraphsState = (json: string[]) => (Array.isArray(json) ? json : []);

/**
 * Helper function that iterates over the asset materializations and assembles time series data
 * and stats for all numeric metadata entries. This function makes the following guaruntees:
 *
 * - If a metadata entry is sparsely emitted, points are still included for missing x values
 *   with y = NaN. (For compatiblity with react-chartjs-2)
 * - If a metadata entry is generated many times for the same partition, and xAxis = partition,
 *   the MAX value emitted is used as the data point.
 *
 * Assumes that the data is pre-sorted in ascending partition order if using xAxis = partition.
 */
const extractNumericData = (datapoints: AssetEventGroup[], xAxis: 'time' | 'partition') => {
  const series: {
    [metadataEntryLabel: string]: AssetValueGraphData;
  } = {};

  // Build a set of the numeric metadata entry labels (note they may be sparsely emitted)
  const numericMetadataLabels = uniq(
    flatMap(datapoints, (e) =>
      (e.latest?.metadataEntries || [])
        .filter((k) => ['IntMetadataEntry', 'FloatMetadataEntry'].includes(k.__typename))
        .map((k) => k.label),
    ),
  );

  const append = (label: string, {x, y}: {x: number | string; y: number}) => {
    series[label] = series[label] || {minX: 0, maxX: 0, minY: 0, maxY: 0, values: [], xAxis};

    if (xAxis === 'partition') {
      // If the xAxis is partition keys, the graph may only contain one value for each partition.
      // If the existing sample for the partition was null, replace it. Otherwise take the
      // most recent value.
      const existingForPartition = series[label].values.find((v) => v.x === x);
      if (existingForPartition) {
        if (!isNaN(y)) {
          existingForPartition.y = y;
        }
        return;
      }
    }
    series[label].values.push({
      xNumeric: typeof x === 'number' ? x : series[label].values.length,
      x,
      y,
    });
  };

  for (const {partition, latest} of datapoints) {
    const x = (xAxis === 'partition' ? partition : Number(latest?.timestamp)) || null;

    if (x === null) {
      // exclude materializations where partition = null from partitioned graphs
      continue;
    }

    // Add an entry for every numeric metadata label
    for (const label of numericMetadataLabels) {
      const entry = latest?.metadataEntries.find((l) => l.label === label);
      if (!entry) {
        append(label, {x, y: NaN});
        continue;
      }

      let y = NaN;
      if (entry.__typename === 'IntMetadataEntry') {
        if (entry.intValue !== null) {
          y = entry.intValue;
        } else {
          // will incur precision loss here
          y = parseInt(entry.intRepr);
        }
      }
      if (entry.__typename === 'FloatMetadataEntry' && entry.floatValue !== null) {
        y = entry.floatValue;
      }

      append(label, {x, y});
    }
  }

  for (const serie of Object.values(series)) {
    const xs = serie.values.map((v) => v.xNumeric);
    const ys = serie.values.map((v) => v.y).filter((v) => !isNaN(v));
    serie.minXNumeric = Math.min(...xs);
    serie.maxXNumeric = Math.max(...xs);
    serie.minY = Math.min(...ys);
    serie.maxY = Math.max(...ys);
  }
  return series;
};
