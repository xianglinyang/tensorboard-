/* Copyright 2016 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import * as THREE from 'three';
import * as d3 from 'd3';

import {
  DataSet,
  DistanceFunction,
  Projection,
  State,
  ProjectionComponents3D,
} from './data';
import {ProjectorEventContext} from './projectorEventContext';
import {LabelRenderParams} from './renderContext';
import {ScatterPlot} from './scatterPlot';
import {ScatterPlotVisualizerSprites} from './scatterPlotVisualizerSprites';
import {ScatterPlotVisualizer3DLabels} from './scatterPlotVisualizer3DLabels';
import {ScatterPlotVisualizerCanvasLabels} from './scatterPlotVisualizerCanvasLabels';
import {ScatterPlotVisualizerPolylines} from './scatterPlotVisualizerPolylines';
import * as knn from './knn';
import * as vector from './vector';

const LABEL_FONT_SIZE = 10;
const LABEL_SCALE_DEFAULT = 1.0;
const LABEL_SCALE_LARGE = 2;
const LABEL_FILL_COLOR_SELECTED = 0x000000;
const LABEL_FILL_COLOR_HOVER = 0x000000;
const LABEL_FILL_COLOR_NEIGHBOR = 0x000000;
const LABEL_STROKE_COLOR_SELECTED = 0xffffff;
const LABEL_STROKE_COLOR_HOVER = 0xffffff;
const LABEL_STROKE_COLOR_NEIGHBOR = 0xffffff;

const POINT_COLOR_UNSELECTED = 0xe3e3e3;
const POINT_COLOR_NO_SELECTION = 0x7575d9;
const POINT_COLOR_SELECTED = 0xfa6666;
const POINT_COLOR_HOVER = 0x760b4f;

const POINT_SCALE_DEFAULT = 1.0;
const POINT_SCALE_SELECTED = 1.2;
const POINT_SCALE_NEIGHBOR = 1.2;
const POINT_SCALE_HOVER = 1.2;

const LABELS_3D_COLOR_UNSELECTED = 0xffffff;
const LABELS_3D_COLOR_NO_SELECTION = 0xffffff;

const SPRITE_IMAGE_COLOR_UNSELECTED = 0xffffff;
const SPRITE_IMAGE_COLOR_NO_SELECTION = 0xffffff;

const POLYLINE_START_HUE = 60;
const POLYLINE_END_HUE = 360;
const POLYLINE_SATURATION = 1;
const POLYLINE_LIGHTNESS = 0.3;

const POLYLINE_DEFAULT_OPACITY = 0.2;
const POLYLINE_DEFAULT_LINEWIDTH = 2;
const POLYLINE_SELECTED_OPACITY = 0.9;
const POLYLINE_SELECTED_LINEWIDTH = 3;
const POLYLINE_DESELECTED_OPACITY = 0.05;

const SCATTER_PLOT_CUBE_LENGTH = 2;

/** Color scale for nearest neighbors. */
const NN_COLOR_SCALE = d3
  .scaleLinear<string, string>()
  .domain([1, 0.7, 0.4])
  .range(['hsl(285, 80%, 40%)', 'hsl(0, 80%, 65%)', 'hsl(40, 70%, 60%)'])
  .clamp(true);
/**
 * Interprets projector events and assembes the arrays and commands necessary
 * to use the ScatterPlot to render the current projected data set.
 */
export class ProjectorScatterPlotAdapter {
  public scatterPlot: ScatterPlot;
  private projection: Projection;
  private hoverPointIndex: number;
  private selectedPointIndices: number[];
  private neighborsOfFirstSelectedPoint: knn.NearestEntry[];
  private renderLabelsIn3D: boolean = false;
  private labelPointAccessor: string;
  private legendPointColorer: (ds: DataSet, index: number) => string;
  private distanceMetric: DistanceFunction;
  private spriteVisualizer: ScatterPlotVisualizerSprites;
  private labels3DVisualizer: ScatterPlotVisualizer3DLabels;
  private canvasLabelsVisualizer: ScatterPlotVisualizerCanvasLabels;
  private polylineVisualizer: ScatterPlotVisualizerPolylines;
  constructor(
    private scatterPlotContainer: HTMLElement,
    projectorEventContext: ProjectorEventContext
  ) {
    this.scatterPlot = new ScatterPlot(
      scatterPlotContainer,
      projectorEventContext
    );
    projectorEventContext.registerProjectionChangedListener((projection) => {
      this.projection = projection;
      this.updateScatterPlotWithNewProjection(projection);
    });
    projectorEventContext.registerSelectionChangedListener(
      (selectedPointIndices, neighbors) => {
        this.selectedPointIndices = selectedPointIndices;
        this.neighborsOfFirstSelectedPoint = neighbors;
        this.updateScatterPlotPositions();
        this.updateScatterPlotAttributes();
        this.scatterPlot.render();
      }
    );
    projectorEventContext.registerHoverListener((hoverPointIndex) => {
      this.hoverPointIndex = hoverPointIndex;
      this.updateScatterPlotAttributes();
      this.scatterPlot.render();
    });
    projectorEventContext.registerDistanceMetricChangedListener(
      (distanceMetric) => {
        this.distanceMetric = distanceMetric;
        this.updateScatterPlotAttributes();
        this.scatterPlot.render();
      }
    );
    this.createVisualizers(false);
  }
  notifyProjectionPositionsUpdated(bg?: string) {
    this.updateScatterPlotPositions(bg);
    this.scatterPlot.render();
  }
  setDataSet(dataSet: DataSet) {
    if (this.projection != null) {
      // TODO(@charlesnicholson): setDataSet needs to go away, the projection is the
      // atomic unit of update.
      this.projection.dataSet = dataSet;
    }
    if (this.polylineVisualizer != null) {
      this.polylineVisualizer.setDataSet(dataSet);
    }
    if (this.labels3DVisualizer != null) {
      this.labels3DVisualizer.setLabelStrings(
        this.generate3DLabelsArray(dataSet, this.labelPointAccessor)
      );
    }
    if (this.spriteVisualizer == null) {
      return;
    }
    this.spriteVisualizer.clearSpriteAtlas();
    if (dataSet == null || dataSet.spriteAndMetadataInfo == null) {
      return;
    }
    const metadata = dataSet.spriteAndMetadataInfo;
    if (metadata.spriteImage == null || metadata.spriteMetadata == null) {
      return;
    }
    const n = dataSet.points.length;
    const spriteIndices = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      spriteIndices[i] = dataSet.points[i].index;
    }
    this.spriteVisualizer.setSpriteAtlas(
      metadata.spriteImage,
      metadata.spriteMetadata.singleImageDim,
      spriteIndices
    );
  }
  set3DLabelMode(renderLabelsIn3D: boolean) {
    this.renderLabelsIn3D = renderLabelsIn3D;
    this.createVisualizers(renderLabelsIn3D);
    this.updateScatterPlotAttributes();
    this.scatterPlot.render();
  }
  setLegendPointColorer(
    legendPointColorer: (ds: DataSet, index: number) => string
  ) {
    this.legendPointColorer = legendPointColorer;
  }
  setLabelPointAccessor(labelPointAccessor: string) {
    this.labelPointAccessor = labelPointAccessor;
    if (this.labels3DVisualizer != null) {
      const ds = this.projection == null ? null : this.projection.dataSet;
      this.labels3DVisualizer.setLabelStrings(
        this.generate3DLabelsArray(ds, labelPointAccessor)
      );
    }
  }
  resize() {
    this.scatterPlot.resize();
  }
  populateBookmarkFromUI(state: State) {
    state.cameraDef = this.scatterPlot.getCameraDef();
  }
  restoreUIFromBookmark(state: State) {
    this.scatterPlot.setCameraParametersForNextCameraCreation(
      state.cameraDef,
      false
    );
  }
  updateScatterPlotPositions(bg?: string) {
    if(bg !== undefined) {
      let image = new Image();
      image.src = bg;
      let texture = new THREE.Texture();
      texture.image = image;
      image.onload = function () {
        texture.needsUpdate = true;
      };
      this.scatterPlot.scene.background = texture;
    }
    const ds = this.projection == null ? null : this.projection.dataSet;
    const projectionComponents =
      this.projection == null ? null : this.projection.projectionComponents;
    const newPositions = this.generatePointPositionArray(
      ds,
      projectionComponents
    );
    this.scatterPlot.setPointPositions(newPositions);
  }
  updateScatterPlotAttributes() {
    if (this.projection == null) {
      return;
    }
    const dataSet = this.projection.dataSet;
    const selectedSet = this.selectedPointIndices;
    const hoverIndex = this.hoverPointIndex;
    const neighbors = this.neighborsOfFirstSelectedPoint;
    const pointColorer = this.legendPointColorer;
    const pointColors = this.generatePointColorArray(
      dataSet,
      pointColorer,
      this.distanceMetric,
      selectedSet,
      neighbors,
      hoverIndex,
      this.renderLabelsIn3D,
      this.getSpriteImageMode()
    );
    const pointScaleFactors = this.generatePointScaleFactorArray(
      dataSet,
      selectedSet,
      neighbors,
      hoverIndex
    );
    const labels = this.generateVisibleLabelRenderParams(
      dataSet,
      selectedSet,
      neighbors,
      hoverIndex
    );
    const polylineColors = this.generateLineSegmentColorMap(
      dataSet,
      pointColorer
    );
    const polylineOpacities = this.generateLineSegmentOpacityArray(
      dataSet,
      selectedSet
    );
    const polylineWidths = this.generateLineSegmentWidthArray(
      dataSet,
      selectedSet
    );
    this.scatterPlot.setPointColors(pointColors);
    this.scatterPlot.setPointScaleFactors(pointScaleFactors);
    this.scatterPlot.setLabels(labels);
    this.scatterPlot.setPolylineColors(polylineColors);
    this.scatterPlot.setPolylineOpacities(polylineOpacities);
    this.scatterPlot.setPolylineWidths(polylineWidths);
  }
  render() {
    this.scatterPlot.render();
  }
  generatePointPositionArray(
    ds: DataSet,
    projectionComponents: ProjectionComponents3D
  ): Float32Array {
    if (ds == null) {
      return null;
    }
    const xScaler = d3.scaleLinear();
    const yScaler = d3.scaleLinear();
    let zScaler = null;
    {
      // Determine max and min of each axis of our data.
      const xExtent = d3.extent(
        ds.points,
        (p, i) => ds.points[i].projections[projectionComponents[0]]
      );
      const yExtent = d3.extent(
        ds.points,
        (p, i) => ds.points[i].projections[projectionComponents[1]]
      );
      const range = [
        -SCATTER_PLOT_CUBE_LENGTH / 2,
        SCATTER_PLOT_CUBE_LENGTH / 2,
      ];
      xScaler.domain(xExtent).range(range);
      yScaler.domain(yExtent).range(range);
      if (projectionComponents[2] != null) {
        const zExtent = d3.extent(
          ds.points,
          (p, i) => ds.points[i].projections[projectionComponents[2]]
        );
        zScaler = d3.scaleLinear();
        zScaler.domain(zExtent).range(range);
      }
    }
    const positions = new Float32Array(ds.points.length * 3);
    let dst = 0;
    ds.points.forEach((d, i) => {
      positions[dst++] = xScaler(
        ds.points[i].projections[projectionComponents[0]]
      );
      positions[dst++] = yScaler(
        ds.points[i].projections[projectionComponents[1]]
      );
      positions[dst++] = 0;
    });
    if (zScaler) {
      dst = 2;
      ds.points.forEach((d, i) => {
        positions[dst] = zScaler(
          ds.points[i].projections[projectionComponents[2]]
        );
        dst += 3;
      });
    }
    return positions;
  }
  generateVisibleLabelRenderParams(
    ds: DataSet,
    selectedPointIndices: number[],
    neighborsOfFirstPoint: knn.NearestEntry[],
    hoverPointIndex: number
  ): LabelRenderParams {
    if (ds == null) {
      return null;
    }
    const selectedPointCount =
      selectedPointIndices == null ? 0 : selectedPointIndices.length;
    const neighborCount =
      neighborsOfFirstPoint == null ? 0 : neighborsOfFirstPoint.length;
    const n =
      selectedPointCount + neighborCount + (hoverPointIndex != null ? 1 : 0);
    const visibleLabels = new Uint32Array(n);
    const scale = new Float32Array(n);
    const opacityFlags = new Int8Array(n);
    const fillColors = new Uint8Array(n * 3);
    const strokeColors = new Uint8Array(n * 3);
    const labelStrings: string[] = [];
    scale.fill(LABEL_SCALE_DEFAULT);
    opacityFlags.fill(1);
    let dst = 0;
    if (hoverPointIndex != null) {
      labelStrings.push(
        this.getLabelText(ds, hoverPointIndex, this.labelPointAccessor)
      );
      visibleLabels[dst] = hoverPointIndex;
      scale[dst] = LABEL_SCALE_LARGE;
      opacityFlags[dst] = 0;
      const fillRgb = styleRgbFromHexColor(LABEL_FILL_COLOR_HOVER);
      packRgbIntoUint8Array(
        fillColors,
        dst,
        fillRgb[0],
        fillRgb[1],
        fillRgb[2]
      );
      const strokeRgb = styleRgbFromHexColor(LABEL_STROKE_COLOR_HOVER);
      packRgbIntoUint8Array(
        strokeColors,
        dst,
        strokeRgb[0],
        strokeRgb[1],
        strokeRgb[1]
      );
      ++dst;
    }
    // Selected points
    {
      const n = selectedPointCount;
      const fillRgb = styleRgbFromHexColor(LABEL_FILL_COLOR_SELECTED);
      const strokeRgb = styleRgbFromHexColor(LABEL_STROKE_COLOR_SELECTED);
      for (let i = 0; i < n; ++i) {
        const labelIndex = selectedPointIndices[i];
        labelStrings.push(
          this.getLabelText(ds, labelIndex, this.labelPointAccessor)
        );
        visibleLabels[dst] = labelIndex;
        scale[dst] = LABEL_SCALE_LARGE;
        opacityFlags[dst] = n === 1 ? 0 : 1;
        packRgbIntoUint8Array(
          fillColors,
          dst,
          fillRgb[0],
          fillRgb[1],
          fillRgb[2]
        );
        packRgbIntoUint8Array(
          strokeColors,
          dst,
          strokeRgb[0],
          strokeRgb[1],
          strokeRgb[2]
        );
        ++dst;
      }
    }
    // Neighbors
    {
      const n = neighborCount;
      const fillRgb = styleRgbFromHexColor(LABEL_FILL_COLOR_NEIGHBOR);
      const strokeRgb = styleRgbFromHexColor(LABEL_STROKE_COLOR_NEIGHBOR);
      for (let i = 0; i < n; ++i) {
        const labelIndex = neighborsOfFirstPoint[i].index;
        labelStrings.push(
          this.getLabelText(ds, labelIndex, this.labelPointAccessor)
        );
        visibleLabels[dst] = labelIndex;
        packRgbIntoUint8Array(
          fillColors,
          dst,
          fillRgb[0],
          fillRgb[1],
          fillRgb[2]
        );
        packRgbIntoUint8Array(
          strokeColors,
          dst,
          strokeRgb[0],
          strokeRgb[1],
          strokeRgb[2]
        );
        ++dst;
      }
    }
    return new LabelRenderParams(
      new Float32Array(visibleLabels),
      labelStrings,
      scale,
      opacityFlags,
      LABEL_FONT_SIZE,
      fillColors,
      strokeColors
    );
  }
  generatePointScaleFactorArray(
    ds: DataSet,
    selectedPointIndices: number[],
    neighborsOfFirstPoint: knn.NearestEntry[],
    hoverPointIndex: number
  ): Float32Array {
    if (ds == null) {
      return new Float32Array(0);
    }
    const scale = new Float32Array(ds.points.length);
    scale.fill(POINT_SCALE_DEFAULT);
    const selectedPointCount =
      selectedPointIndices == null ? 0 : selectedPointIndices.length;
    const neighborCount =
      neighborsOfFirstPoint == null ? 0 : neighborsOfFirstPoint.length;
    // Scale up all selected points.
    {
      const n = selectedPointCount;
      for (let i = 0; i < n; ++i) {
        const p = selectedPointIndices[i];
        scale[p] = POINT_SCALE_SELECTED;
      }
    }
    // Scale up the neighbor points.
    {
      const n = neighborCount;
      for (let i = 0; i < n; ++i) {
        const p = neighborsOfFirstPoint[i].index;
        scale[p] = POINT_SCALE_NEIGHBOR;
      }
    }
    // Scale up the hover point.
    if (hoverPointIndex != null) {
      scale[hoverPointIndex] = POINT_SCALE_HOVER;
    }
    return scale;
  }
  generateLineSegmentColorMap(
    ds: DataSet,
    legendPointColorer: (ds: DataSet, index: number) => string
  ): {
    [polylineIndex: number]: Float32Array;
  } {
    let polylineColorArrayMap: {
      [polylineIndex: number]: Float32Array;
    } = {};
    if (ds == null) {
      return polylineColorArrayMap;
    }
    for (let i = 0; i < ds.sequences.length; i++) {
      let sequence = ds.sequences[i];
      let colors = new Float32Array(2 * (sequence.pointIndices.length - 1) * 3);
      let colorIndex = 0;
      if (legendPointColorer) {
        for (let j = 0; j < sequence.pointIndices.length - 1; j++) {
          const c1 = new THREE.Color(
            legendPointColorer(ds, sequence.pointIndices[j])
          );
          const c2 = new THREE.Color(
            legendPointColorer(ds, sequence.pointIndices[j + 1])
          );
          colors[colorIndex++] = c1.r;
          colors[colorIndex++] = c1.g;
          colors[colorIndex++] = c1.b;
          colors[colorIndex++] = c2.r;
          colors[colorIndex++] = c2.g;
          colors[colorIndex++] = c2.b;
        }
      } else {
        for (let j = 0; j < sequence.pointIndices.length - 1; j++) {
          const c1 = getDefaultPointInPolylineColor(
            j,
            sequence.pointIndices.length
          );
          const c2 = getDefaultPointInPolylineColor(
            j + 1,
            sequence.pointIndices.length
          );
          colors[colorIndex++] = c1.r;
          colors[colorIndex++] = c1.g;
          colors[colorIndex++] = c1.b;
          colors[colorIndex++] = c2.r;
          colors[colorIndex++] = c2.g;
          colors[colorIndex++] = c2.b;
        }
      }
      polylineColorArrayMap[i] = colors;
    }
    return polylineColorArrayMap;
  }
  generateLineSegmentOpacityArray(
    ds: DataSet,
    selectedPoints: number[]
  ): Float32Array {
    if (ds == null) {
      return new Float32Array(0);
    }
    const opacities = new Float32Array(ds.sequences.length);
    const selectedPointCount =
      selectedPoints == null ? 0 : selectedPoints.length;
    if (selectedPointCount > 0) {
      opacities.fill(POLYLINE_DESELECTED_OPACITY);
      const i = ds.points[selectedPoints[0]].sequenceIndex;
      opacities[i] = POLYLINE_SELECTED_OPACITY;
    } else {
      opacities.fill(POLYLINE_DEFAULT_OPACITY);
    }
    return opacities;
  }
  generateLineSegmentWidthArray(
    ds: DataSet,
    selectedPoints: number[]
  ): Float32Array {
    if (ds == null) {
      return new Float32Array(0);
    }
    const widths = new Float32Array(ds.sequences.length);
    widths.fill(POLYLINE_DEFAULT_LINEWIDTH);
    const selectedPointCount =
      selectedPoints == null ? 0 : selectedPoints.length;
    if (selectedPointCount > 0) {
      const i = ds.points[selectedPoints[0]].sequenceIndex;
      widths[i] = POLYLINE_SELECTED_LINEWIDTH;
    }
    return widths;
  }
  generatePointColorArray(
    ds: DataSet,
    legendPointColorer: (ds: DataSet, index: number) => string,
    distFunc: DistanceFunction,
    selectedPointIndices: number[],
    neighborsOfFirstPoint: knn.NearestEntry[],
    hoverPointIndex: number,
    label3dMode: boolean,
    spriteImageMode: boolean
  ): Float32Array {
    if (ds == null) {
      return new Float32Array(0);
    }
    const selectedPointCount =
      selectedPointIndices == null ? 0 : selectedPointIndices.length;
    const neighborCount =
      neighborsOfFirstPoint == null ? 0 : neighborsOfFirstPoint.length;
    const colors = new Float32Array(ds.points.length * 3);
    let unselectedColor = POINT_COLOR_UNSELECTED;
    let noSelectionColor = POINT_COLOR_NO_SELECTION;
    if (label3dMode) {
      unselectedColor = LABELS_3D_COLOR_UNSELECTED;
      noSelectionColor = LABELS_3D_COLOR_NO_SELECTION;
    }
    if (spriteImageMode) {
      unselectedColor = SPRITE_IMAGE_COLOR_UNSELECTED;
      noSelectionColor = SPRITE_IMAGE_COLOR_NO_SELECTION;
    }
    // Give all points the unselected color.
    {
      const n = ds.points.length;
      let dst = 0;
      if (selectedPointCount > 0) {
        const c = new THREE.Color(unselectedColor);
        for (let i = 0; i < n; ++i) {
          colors[dst++] = c.r;
          colors[dst++] = c.g;
          colors[dst++] = c.b;
        }
      } else {
        if (legendPointColorer != null) {
          for (let i = 0; i < n; ++i) {
            const c = new THREE.Color(legendPointColorer(ds, i));
            colors[dst++] = c.r;
            colors[dst++] = c.g;
            colors[dst++] = c.b;
          }
        } else {
          const c = new THREE.Color(noSelectionColor);
          for (let i = 0; i < n; ++i) {
            colors[dst++] = c.r;
            colors[dst++] = c.g;
            colors[dst++] = c.b;
          }
        }
      }
    }
    // Color the selected points.
    {
      const n = selectedPointCount;
      const c = new THREE.Color(POINT_COLOR_SELECTED);
      for (let i = 0; i < n; ++i) {
        let dst = selectedPointIndices[i] * 3;
        colors[dst++] = c.r;
        colors[dst++] = c.g;
        colors[dst++] = c.b;
      }
    }
    // Color the neighbors.
    {
      const n = neighborCount;
      let minDist = n > 0 ? neighborsOfFirstPoint[0].dist : 0;
      for (let i = 0; i < n; ++i) {
        const c = new THREE.Color(
          dist2color(distFunc, neighborsOfFirstPoint[i].dist, minDist)
        );
        let dst = neighborsOfFirstPoint[i].index * 3;
        colors[dst++] = c.r;
        colors[dst++] = c.g;
        colors[dst++] = c.b;
      }
    }
    // Color the hover point.
    if (hoverPointIndex != null) {
      const c = new THREE.Color(POINT_COLOR_HOVER);
      let dst = hoverPointIndex * 3;
      colors[dst++] = c.r;
      colors[dst++] = c.g;
      colors[dst++] = c.b;
    }
    return colors;
  }
  generate3DLabelsArray(ds: DataSet, accessor: string) {
    if (ds == null || accessor == null) {
      return null;
    }
    let labels: string[] = [];
    const n = ds.points.length;
    for (let i = 0; i < n; ++i) {
      labels.push(this.getLabelText(ds, i, accessor));
    }
    return labels;
  }
  private getLabelText(ds: DataSet, i: number, accessor: string): string {
    return ds.points[i].metadata[accessor] !== undefined
      ? String(ds.points[i].metadata[accessor])
      : `Unknown #${i}`;
  }
  private updateScatterPlotWithNewProjection(projection: Projection) {
    if (projection == null) {
      this.createVisualizers(this.renderLabelsIn3D);
      this.scatterPlot.render();
      return;
    }
    this.setDataSet(projection.dataSet);
    this.scatterPlot.setDimensions(projection.dimensionality);
    if (projection.dataSet.projectionCanBeRendered(projection.projectionType)) {
      this.updateScatterPlotAttributes();
      this.notifyProjectionPositionsUpdated();
    }
    this.scatterPlot.setCameraParametersForNextCameraCreation(null, false);
  }
  private createVisualizers(inLabels3DMode: boolean) {
    const ds = this.projection == null ? null : this.projection.dataSet;
    const scatterPlot = this.scatterPlot;
    scatterPlot.removeAllVisualizers();
    this.labels3DVisualizer = null;
    this.canvasLabelsVisualizer = null;
    this.spriteVisualizer = null;
    this.polylineVisualizer = null;
    if (inLabels3DMode) {
      this.labels3DVisualizer = new ScatterPlotVisualizer3DLabels();
      this.labels3DVisualizer.setLabelStrings(
        this.generate3DLabelsArray(ds, this.labelPointAccessor)
      );
    } else {
      this.spriteVisualizer = new ScatterPlotVisualizerSprites();
      scatterPlot.addVisualizer(this.spriteVisualizer);
      this.canvasLabelsVisualizer = new ScatterPlotVisualizerCanvasLabels(
        this.scatterPlotContainer
      );
    }
    this.polylineVisualizer = new ScatterPlotVisualizerPolylines();
    this.setDataSet(ds);
    if (this.spriteVisualizer) {
      scatterPlot.addVisualizer(this.spriteVisualizer);
    }
    if (this.labels3DVisualizer) {
      scatterPlot.addVisualizer(this.labels3DVisualizer);
    }
    if (this.canvasLabelsVisualizer) {
      scatterPlot.addVisualizer(this.canvasLabelsVisualizer);
    }
    scatterPlot.addVisualizer(this.polylineVisualizer);
  }
  private getSpriteImageMode(): boolean {
    if (this.projection == null) {
      return false;
    }
    const ds = this.projection.dataSet;
    if (ds == null || ds.spriteAndMetadataInfo == null) {
      return false;
    }
    return ds.spriteAndMetadataInfo.spriteImage != null;
  }
}
function packRgbIntoUint8Array(
  rgbArray: Uint8Array,
  labelIndex: number,
  r: number,
  g: number,
  b: number
) {
  rgbArray[labelIndex * 3] = r;
  rgbArray[labelIndex * 3 + 1] = g;
  rgbArray[labelIndex * 3 + 2] = b;
}
function styleRgbFromHexColor(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [(c.r * 255) | 0, (c.g * 255) | 0, (c.b * 255) | 0];
}
function getDefaultPointInPolylineColor(
  index: number,
  totalPoints: number
): THREE.Color {
  let hue =
    POLYLINE_START_HUE +
    ((POLYLINE_END_HUE - POLYLINE_START_HUE) * index) / totalPoints;
  let rgb = d3.hsl(hue, POLYLINE_SATURATION, POLYLINE_LIGHTNESS).rgb();
  return new THREE.Color(rgb.r / 255, rgb.g / 255, rgb.b / 255);
}
/**
 * Normalizes the distance so it can be visually encoded with color.
 * The normalization depends on the distance metric (cosine vs euclidean).
 */
export function normalizeDist(
  distFunc: DistanceFunction,
  d: number,
  minDist: number
): number {
  return distFunc === vector.dist ? minDist / d : 1 - d;
}
/** Normalizes and encodes the provided distance with color. */
export function dist2color(
  distFunc: DistanceFunction,
  d: number,
  minDist: number
): string {
  return NN_COLOR_SCALE(normalizeDist(distFunc, d, minDist));
}
