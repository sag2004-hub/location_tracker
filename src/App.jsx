import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Circle,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

// Utility: Haversine formula (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Generate unique device ID
function generateDeviceId() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillText('Device fingerprint', 2, 2);
  const fingerprint = canvas.toDataURL();
  return 'device-' + btoa(fingerprint).slice(0, 12) + '-' + Date.now().toString(36);
}

// Road routing service
class RoutingService {
  static async getRoute(fromLat, fromLng, toLat, toLng, profile = 'driving') {
    try {
      // Using OSRM for routing (free and reliable)
      const url = `https://router.project-osrm.org/route/v1/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Routing service unavailable');
      }
      const data = await response.json();
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        return {
          coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]), // Convert to [lat, lng]
          distance: route.distance / 1000, // Convert meters to km
          duration: route.duration / 60, // Convert seconds to minutes
          steps: route.legs[0]?.steps || []
        };
      }
      throw new Error('No route found');
    } catch (error) {
      console.warn('Road routing failed, using direct path:', error);
      // Fallback to straight line
      return {
        coordinates: [[fromLat, fromLng], [toLat, toLng]],
        distance: haversine(fromLat, fromLng, toLat, toLng),
        duration: haversine(fromLat, fromLng, toLat, toLng) * 2, // Rough estimate: 30 km/h average
        steps: [],
        isFallback: true
      };
    }
  }

  static async getMultipleRoutes(fromLat, fromLng, destinations) {
    const routes = await Promise.allSettled(
      destinations.map(dest =>
        this.getRoute(fromLat, fromLng, dest.position[0], dest.position[1])
      )
    );
    return destinations.map((dest, index) => {
      const routeResult = routes[index];
      if (routeResult.status === 'fulfilled') {
        return {
          ...dest,
          route: routeResult.value,
          roadDistance: routeResult.value.distance,
          estimatedTime: routeResult.value.duration
        };
      } else {
        return {
          ...dest,
          route: null,
          roadDistance: dest.distance,
          estimatedTime: dest.distance * 2
        };
      }
    });
  }
}

// Enhanced hospital finder with work context
class WorkCentricHospitalService {
  static async findNearbyHospitals(latitude, longitude, radiusKm = 10) {
    try {
      const overpassUrl = 'https://overpass-api.de/api/interpreter';
      const query = `[out:json][timeout:25]; ( node["amenity"="hospital"](around:${radiusKm * 1000},${latitude},${longitude}); way["amenity"="hospital"](around:${radiusKm * 1000},${latitude},${longitude}); relation["amenity"="hospital"](around:${radiusKm * 1000},${latitude},${longitude}); node["amenity"="clinic"](around:${radiusKm * 1000},${latitude},${longitude}); node["healthcare"="hospital"](around:${radiusKm * 1000},${latitude},${longitude}); ); out center meta;`;
      const response = await fetch(overpassUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!response.ok) {
        throw new Error('Failed to fetch hospitals');
      }
      const data = await response.json();
      const hospitals = data.elements.map(element => {
        let lat, lon;
        if (element.type === 'node') {
          lat = element.lat;
          lon = element.lon;
        } else if (element.center) {
          lat = element.center.lat;
          lon = element.center.lon;
        } else if (element.type === 'way' && element.nodes) {
          return null;
        }
        if (!lat || !lon) return null;
        const distance = haversine(latitude, longitude, lat, lon);
        const isEmergency = element.tags?.emergency === 'yes' ||
          element.tags?.['emergency:medical'] === 'yes' ||
          element.tags?.['healthcare:speciality']?.includes('emergency');
        let workPriority = 0;
        if (isEmergency) workPriority += 10;
        if (element.tags?.wheelchair === 'yes') workPriority += 5;
        if (element.tags?.['opening_hours:emergency']) workPriority += 3;
        if (distance < 2) workPriority += 8;
        else if (distance < 5) workPriority += 5;
        else if (distance < 10) workPriority += 2;
        return {
          id: `hospital-${element.id}`,
          name: element.tags?.name || element.tags?.['name:en'] || 'Medical Facility',
          type: element.tags?.amenity === 'clinic' ? 'clinic' : 'hospital',
          position: [lat, lon],
          distance: distance,
          address: element.tags?.['addr:street'] || element.tags?.['addr:full'] || '',
          phone: element.tags?.phone || element.tags?.['contact:phone'] || '',
          emergency: isEmergency,
          website: element.tags?.website || element.tags?.['contact:website'] || '',
          wheelchairAccess: element.tags?.wheelchair === 'yes',
          openingHours: element.tags?.opening_hours || '',
          emergencyHours: element.tags?.['opening_hours:emergency'] || '',
          specialties: element.tags?.['healthcare:speciality'] || '',
          workPriority: workPriority,
          tags: element.tags || {}
        };
      }).filter(h => h !== null);
      hospitals.sort((a, b) => {
        if (b.workPriority !== a.workPriority) {
          return b.workPriority - a.workPriority;
        }
        return a.distance - b.distance;
      });
      return hospitals;
    } catch (error) {
      console.error('Error finding hospitals:', error);
      return this.getFallbackHospitals(latitude, longitude);
    }
  }

  static getFallbackHospitals(latitude, longitude) {
    const fallbackHospitals = [
      { name: "Emergency Medical Center", lat: latitude + 0.01, lon: longitude + 0.01, emergency: true },
      { name: "General Hospital", lat: latitude - 0.01, lon: longitude + 0.01, emergency: false },
      { name: "City Medical Center", lat: latitude + 0.01, lon: longitude - 0.01, emergency: false },
      { name: "Regional Hospital", lat: latitude - 0.01, lon: longitude - 0.01, emergency: true },
    ];
    return fallbackHospitals.map((hospital, index) => ({
      id: `fallback-hospital-${index}`,
      name: hospital.name,
      type: 'hospital',
      position: [hospital.lat, hospital.lon],
      distance: haversine(latitude, longitude, hospital.lat, hospital.lon),
      address: 'Address not available',
      phone: 'Emergency: 911',
      emergency: hospital.emergency,
      website: '',
      wheelchairAccess: false,
      workPriority: hospital.emergency ? 10 : 5,
      tags: {}
    })).sort((a, b) => b.workPriority - a.workPriority);
  }
}

// Optimized network pathfinder for work scenarios
class OptimizedNetworkPathfinder {
  static findWorkOptimalPaths(devices, hospitals = []) {
    const nodes = devices.filter(d => d.position && d.isOnline);
    if (nodes.length < 2) return [];
    const paths = [];
    const hospitalPositions = hospitals.slice(0, 3).map(h => h.position);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dist = haversine(
          nodes[i].position[0], nodes[i].position[1],
          nodes[j].position[0], nodes[j].position[1]
        );
        let workScore = 100 - (dist * 10);
        hospitalPositions.forEach(hospitalPos => {
          const node1ToHospital = haversine(nodes[i].position[0], nodes[i].position[1], hospitalPos[0], hospitalPos[1]);
          const node2ToHospital = haversine(nodes[j].position[0], nodes[j].position[1], hospitalPos[0], hospitalPos[1]);
          if (node1ToHospital < 2 || node2ToHospital < 2) {
            workScore += 20;
          }
        });
        paths.push({
          distance: dist,
          from: nodes[i],
          to: nodes[j],
          positions: [nodes[i].position, nodes[j].position],
          workScore: workScore
        });
      }
    }
    return paths.sort((a, b) => b.workScore - a.workScore);
  }

  static findMinimumSpanningTree(devices, hospitals = []) {
    const paths = this.findWorkOptimalPaths(devices, hospitals);
    if (paths.length === 0) return [];
    paths.sort((a, b) => a.distance - b.distance);
    const mst = [];
    const connectedNodes = new Set();
    for (const path of paths) {
      const fromConnected = connectedNodes.has(path.from.id);
      const toConnected = connectedNodes.has(path.to.id);
      if (!fromConnected || !toConnected) {
        mst.push(path);
        connectedNodes.add(path.from.id);
        connectedNodes.add(path.to.id);
        if (mst.length === devices.filter(d => d.position && d.isOnline).length - 1) {
          break;
        }
      }
    }
    return mst;
  }

  static createEmergencyTopology(devices, hospitals = []) {
    const onlineDevices = devices.filter(d => d.position && d.isOnline);
    if (onlineDevices.length === 0 || hospitals.length === 0) return [];
    const nearestHospital = hospitals[0];
    const connections = [];
    let closestToHospital = onlineDevices[0];
    let shortestDistToHospital = haversine(
      closestToHospital.position[0], closestToHospital.position[1],
      nearestHospital.position[0], nearestHospital.position[1]
    );
    onlineDevices.forEach(device => {
      const distToHospital = haversine(
        device.position[0], device.position[1],
        nearestHospital.position[0], nearestHospital.position[1]
      );
      if (distToHospital < shortestDistToHospital) {
        closestToHospital = device;
        shortestDistToHospital = distToHospital;
      }
    });
    onlineDevices.forEach(device => {
      if (device.id !== closestToHospital.id) {
        connections.push({
          distance: haversine(
            closestToHospital.position[0], closestToHospital.position[1],
            device.position[0], device.position[1]
          ),
          from: closestToHospital,
          to: device,
          positions: [closestToHospital.position, device.position],
          isEmergencyPath: true
        });
      }
    });
    return connections;
  }
}

// Work-centric location service
class WorkCentricLocationService {
  constructor() {
    this.devices = new Map();
    this.hospitals = [];
    this.hospitalRoutes = [];
    this.subscribers = new Set();
    this.networkTopology = 'emergency';
    this.connections = [];
    this.workContext = {
      emergencyMode: false,
      prioritizeSpeed: true,
      maxResponseTime: 15 // minutes
    };
    this.routingCache = new Map();
  }

  async updateHospitals(latitude, longitude, radiusKm = 2) {
    try {
      this.hospitals = await WorkCentricHospitalService.findNearbyHospitals(latitude, longitude, radiusKm);
      if (this.hospitals.length > 0) {
        const topHospitals = this.hospitals.slice(0, 5);
        this.hospitalRoutes = await RoutingService.getMultipleRoutes(latitude, longitude, topHospitals);
        this.hospitalRoutes.sort((a, b) => {
          const scoreA = a.workPriority + (20 / (a.roadDistance + 0.1));
          const scoreB = b.workPriority + (20 / (b.roadDistance + 0.1));
          return scoreB - scoreA;
        });
        this.autoSelectShortestRoute = this.hospitalRoutes.length > 0 ? this.hospitalRoutes[0] : null;
      }
      this.notifySubscribers();
    } catch (error) {
      console.error('Failed to update hospitals:', error);
    }
  }

  setEmergencyMode(enabled) {
    this.workContext.emergencyMode = enabled;
    if (enabled) {
      this.networkTopology = 'emergency';
    }
    this.updateNetworkTopology();
  }

  updateNetworkTopology() {
    const devices = Array.from(this.devices.values());
    const onlineDevices = devices.filter(d => d.position && d.isOnline);
    if (onlineDevices.length < 2) {
      this.connections = [];
      return;
    }
    switch (this.networkTopology) {
      case 'emergency':
        this.connections = OptimizedNetworkPathfinder.createEmergencyTopology(onlineDevices, this.hospitals);
        break;
      case 'work-optimal':
        this.connections = OptimizedNetworkPathfinder.findWorkOptimalPaths(onlineDevices, this.hospitals).slice(0, onlineDevices.length * 2);
        break;
      case 'mst':
        this.connections = OptimizedNetworkPathfinder.findMinimumSpanningTree(onlineDevices, this.hospitals);
        break;
      default:
        this.connections = OptimizedNetworkPathfinder.createEmergencyTopology(onlineDevices, this.hospitals);
    }
    this.assignWorkRoles(onlineDevices);
  }

  assignWorkRoles(devices) {
    devices.forEach(device => {
      device.workRole = 'worker';
      device.emergencyResponder = false;
    });
    if (this.hospitals.length > 0 && devices.length > 0) {
      const nearestHospital = this.hospitals[0];
      let closestDevice = devices[0];
      let shortestDist = haversine(
        closestDevice.position[0], closestDevice.position[1],
        nearestHospital.position[0], nearestHospital.position[1]
      );
      devices.forEach(device => {
        const dist = haversine(
          device.position[0], device.position[1],
          nearestHospital.position[0], nearestHospital.position[1]
        );
        if (dist < shortestDist) {
          closestDevice = device;
          shortestDist = dist;
        }
      });
      closestDevice.workRole = 'emergency-responder';
      closestDevice.emergencyResponder = true;
    }
  }

  registerDevice(deviceId, deviceName, workRole = 'worker') {
    const device = {
      id: deviceId,
      name: deviceName,
      position: null,
      lastUpdate: null,
      isOnline: true,
      accuracy: 0,
      workRole: workRole,
      emergencyResponder: false,
      lastEmergencyUpdate: null
    };
    this.devices.set(deviceId, device);
    this.updateNetworkTopology();
    return device;
  }

  async updateDeviceLocation(deviceId, position, accuracy = 0) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.position = position;
      device.lastUpdate = new Date();
      device.accuracy = accuracy;
      device.isOnline = true;
      await this.updateHospitals(position[0], position[1]);
      this.updateNetworkTopology();
      setTimeout(() => {
        this.notifySubscribers();
      }, 100);
    }
  }

  getEmergencyRoute() {
    if (this.hospitalRoutes.length > 0) {
      return this.hospitalRoutes[0];
    }
    return null;
  }

  getShortestRoute() {
    return this.autoSelectShortestRoute;
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notifySubscribers() {
    const deviceList = Array.from(this.devices.values());
    this.subscribers.forEach(callback => callback({
      devices: deviceList,
      connections: this.connections,
      hospitals: this.hospitals,
      hospitalRoutes: this.hospitalRoutes,
      topology: this.networkTopology,
      workContext: this.workContext,
      emergencyRoute: this.getEmergencyRoute(),
      shortestRoute: this.getShortestRoute()
    }));
  }

  getAllDevices() {
    return Array.from(this.devices.values());
  }

  removeDevice(deviceId) {
    this.devices.delete(deviceId);
    this.updateNetworkTopology();
    this.notifySubscribers();
  }

  setNetworkTopology(topology) {
    this.networkTopology = topology;
    this.updateNetworkTopology();
  }

  markOfflineIfStale() {
    const now = new Date();
    let changed = false;
    this.devices.forEach((device) => {
      if (device.lastUpdate && (now - device.lastUpdate) > 30000) {
        if (device.isOnline) {
          device.isOnline = false;
          changed = true;
        }
      }
    });
    if (changed) {
      this.updateNetworkTopology();
      this.notifySubscribers();
    }
  }
}

const locationService = new WorkCentricLocationService();

// Map update component
function MapUpdater({ center, hospitalRoutes, selectedRoute }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.setView(center, map.getZoom());
    }
  }, [center, map]);
  return null;
}

export default function OptimizedHospitalTracker() {
  const [myDeviceId] = useState(() => generateDeviceId());
  const [myDeviceName, setMyDeviceName] = useState('');
  const [networkData, setNetworkData] = useState({
    devices: [],
    connections: [],
    hospitals: [],
    hospitalRoutes: [],
    topology: 'emergency',
    emergencyRoute: null
  });
  const [myPosition, setMyPosition] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [autoRouting, setAutoRouting] = useState(true);
  const [isTracking, setIsTracking] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [emergencyMode, setEmergencyMode] = useState(false);
  const [hospitalRadius, setHospitalRadius] = useState(2);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [locationError, setLocationError] = useState(null);
  const [watchId, setWatchId] = useState(null);
  const [locationPermission, setLocationPermission] = useState('prompt');
  const [locationAccuracy, setLocationAccuracy] = useState(null);
  const [lastLocationUpdate, setLastLocationUpdate] = useState(null);
  // ----- FIX: Added the missing routingStatus state variable -----
  const [routingStatus, setRoutingStatus] = useState('Idle');

  // ----- HELPER FUNCTIONS: Added to prevent "not defined" errors -----
  const checkLocationPermission = async () => {
    // In a real app, you'd use navigator.permissions.query
    return 'prompt'; 
  };
  
  const requestLocationPermission = async () => {
    // This is handled by navigator.geolocation.watchPosition which prompts the user
    return;
  };

  useEffect(() => {
    const saved = "Worker-" + myDeviceId.slice(-4);
    setMyDeviceName(saved);
  }, [myDeviceId]);

  useEffect(() => {
    const unsubscribe = locationService.subscribe((data) => {
      setNetworkData(data);
      if (data.shortestRoute && autoRouting && (!selectedRoute || selectedRoute.id !== data.shortestRoute.id)) {
        setSelectedRoute(data.shortestRoute);
        setRoutingStatus('Shortest route auto-selected');
      } else if (data.emergencyRoute && !selectedRoute) {
        setSelectedRoute(data.emergencyRoute);
      }
    });
    const interval = setInterval(() => {
      locationService.markOfflineIfStale();
    }, 5000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [selectedRoute, autoRouting]);

  const startLocationTracking = useCallback(async () => {
    try {
      setConnectionStatus('Requesting location permission...');
      setLocationError(null);
      setRoutingStatus('Checking location access...');
      if (!navigator.geolocation) {
        throw new Error('Geolocation is not supported by this browser');
      }
      const permissionStatus = await checkLocationPermission();
      if (permissionStatus === 'denied') {
        throw new Error('Location access was previously denied. Please enable location access in your browser settings.');
      }
      setConnectionStatus('Waiting for location permission...');
      await requestLocationPermission();
      const options = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000
      };
      const successCallback = async (position) => {
        const coords = [position.coords.latitude, position.coords.longitude];
        const accuracy = position.coords.accuracy;
        const timestamp = new Date(position.timestamp);
        console.log('Location detected:', {
          latitude: coords[0],
          longitude: coords[1],
          accuracy: accuracy,
          timestamp: timestamp
        });
        setMyPosition(coords);
        setLocationAccuracy(accuracy);
        setLastLocationUpdate(timestamp);
        setConnectionStatus('Location tracking active');
        setLocationError(null);
        setRoutingStatus('Updating location...');
        if (isSharing) {
          await locationService.updateDeviceLocation(myDeviceId, coords, accuracy);
        } else {
          await locationService.updateHospitals(coords[0], coords[1], hospitalRadius);
        }
        setTimeout(() => {
          if (autoRouting && networkData.hospitalRoutes.length > 0) {
            const shortest = networkData.hospitalRoutes[0];
            if (shortest && (!selectedRoute || shortest.roadDistance < selectedRoute.roadDistance)) {
              setSelectedRoute(shortest);
              setRoutingStatus(`Auto-selected: ${shortest.name} (${shortest.roadDistance.toFixed(1)} km)`);
            }
          } else {
            setRoutingStatus('Location updated - hospitals found');
          }
        }, 1000);
      };
      const errorCallback = (error) => {
        let message = 'Location error occurred';
        let suggestion = '';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setLocationPermission('denied');
            message = 'Location access denied';
            suggestion = 'Please allow location access in your browser settings and refresh the page';
            break;
          case error.POSITION_UNAVAILABLE:
            message = 'Your location could not be determined';
            suggestion = 'Make sure location services are enabled on your device';
            break;
          case error.TIMEOUT:
            message = 'Location request timed out';
            suggestion = 'Please try again or check your internet connection';
            break;
          default:
            message = 'Unknown location error';
            suggestion = 'Please try refreshing the page';
        }
        setLocationError(message + (suggestion ? '. ' + suggestion : ''));
        setConnectionStatus('Location error');
        setRoutingStatus('Error getting location');
        console.error('Location error:', error);
      };
      const id = navigator.geolocation.watchPosition(
        successCallback,
        errorCallback,
        options
      );
      setWatchId(id);
      setConnectionStatus('Locating device...');
    } catch (error) {
      setLocationError(error.message);
      setConnectionStatus('Error');
      setRoutingStatus('Location access failed');
      console.error('Location setup error:', error);
    }
  }, [myDeviceId, isSharing, hospitalRadius, autoRouting, selectedRoute, networkData.hospitalRoutes]);

  const stopLocationTracking = useCallback(() => {
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      setWatchId(null);
    }
    setConnectionStatus('Disconnected');
    setIsTracking(false);
    setIsSharing(false);
    locationService.removeDevice(myDeviceId);
    setRoutingStatus('Stopped');
  }, [watchId, myDeviceId]);

  const toggleTracking = () => {
    if (isTracking) {
      stopLocationTracking();
    } else {
      setIsTracking(true);
      startLocationTracking();
    }
  };

  const toggleSharing = () => {
    if (!isSharing && myPosition) {
      locationService.registerDevice(myDeviceId, myDeviceName);
      locationService.updateDeviceLocation(myDeviceId, myPosition);
      setIsSharing(true);
    } else {
      locationService.removeDevice(myDeviceId);
      setIsSharing(false);
    }
  };

  const toggleEmergencyMode = () => {
    const newMode = !emergencyMode;
    setEmergencyMode(newMode);
    locationService.setEmergencyMode(newMode);
  };

  const selectShortestRoute = () => {
    if (networkData.hospitalRoutes.length > 0) {
      const shortest = networkData.hospitalRoutes.reduce((shortest, current) =>
        current.roadDistance < shortest.roadDistance ? current : shortest
      );
      setSelectedRoute(shortest);
      setRoutingStatus(`Selected shortest: ${shortest.name} (${shortest.roadDistance.toFixed(1)} km)`);
    }
  };

  const selectHospitalRoute = async (hospital) => {
    if (myPosition && hospital.position) {
      setRoutingStatus('Calculating route...');
      const route = await RoutingService.getRoute(
        myPosition[0], myPosition[1],
        hospital.position[0], hospital.position[1]
      );
      setSelectedRoute({
        ...hospital,
        route: route,
        roadDistance: route.distance,
        estimatedTime: route.duration
      });
      setRoutingStatus('Route ready');
    }
  };

  const centerPosition = myPosition || [22.5958, 88.2636]; // Default to Rabindrakanan, West Bengal area
  const emergencyRoute = networkData.emergencyRoute;

  const getRouteColor = (route) => {
    if (!route) return '#ef4444';
    if (route.roadDistance < 2) return '#10B981';
    if (route.roadDistance < 5) return '#3B82F6';
    if (route.roadDistance < 10) return '#F59E0B';
    return '#EF4444';
  };

  const getPriorityBadge = (hospital) => {
    if (hospital.emergency && hospital.roadDistance < 2) return { text: 'CRITICAL', color: 'bg-red-600' };
    if (hospital.emergency) return { text: 'EMERGENCY', color: 'bg-red-500' };
    if (hospital.roadDistance < 1) return { text: 'VERY CLOSE', color: 'bg-green-500' };
    return { text: 'AVAILABLE', color: 'bg-blue-500' };
  };

  useEffect(() => {
    return () => {
      if (watchId) {
        navigator.geolocation.clearWatch(watchId);
      }
      locationService.removeDevice(myDeviceId);
    };
  }, [watchId, myDeviceId]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      <div className="bg-white shadow-lg border-b-2">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Emergency Response Network</h1>
              <div className="flex items-center space-x-4 mt-2">
                <input
                  type="text"
                  value={myDeviceName}
                  onChange={(e) => setMyDeviceName(e.target.value)}
                  className="text-sm bg-gray-100 border rounded px-3 py-2"
                  placeholder="Worker ID"
                />
                <div className="flex items-center space-x-2">
                  <button
                    onClick={toggleEmergencyMode}
                    className={`px-4 py-2 rounded-full text-sm font-semibold ${emergencyMode ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'}`}
                  >
                    {emergencyMode ? 'EMERGENCY MODE' : 'Normal Mode'}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              {emergencyRoute && (
                <div className="bg-red-100 border border-red-300 rounded-lg px-4 py-2">
                  <div className="font-semibold text-red-900">Nearest Emergency Care</div>
                  <div className="text-sm text-red-700">
                    {emergencyRoute.name} - {emergencyRoute.roadDistance.toFixed(1)} km
                  </div>
                  <div className="text-xs text-red-600">
                    Est. {emergencyRoute.estimatedTime.toFixed(0)} min by car
                  </div>
                </div>
              )}
              {myPosition && (
                <div className="bg-blue-100 border border-blue-300 rounded-lg px-4 py-2">
                  <div className="font-semibold text-blue-900">Your Location</div>
                  <div className="text-sm text-blue-700">
                    {myPosition[0].toFixed(6)}, {myPosition[1].toFixed(6)}
                  </div>
                  {locationAccuracy && (
                    <div className="text-xs text-blue-600">
                      Accuracy: ±{Math.round(locationAccuracy)}m
                    </div>
                  )}
                  {lastLocationUpdate && (
                    <div className="text-xs text-blue-600">
                      Updated: {lastLocationUpdate.toLocaleTimeString()}
                    </div>
                  )}
                </div>
              )}
              <div className={`flex items-center px-4 py-2 rounded-full text-sm font-medium ${connectionStatus === 'Location tracking active' ? 'bg-green-100 text-green-800' :
                  connectionStatus.includes('permission') ? 'bg-yellow-100 text-yellow-800' :
                    connectionStatus === 'Locating device...' ? 'bg-blue-100 text-blue-800' :
                      connectionStatus === 'Error' ? 'bg-red-100 text-red-800' :
                        'bg-gray-100 text-gray-700'
                }`}>
                <div className={`w-3 h-3 rounded-full mr-2 ${connectionStatus === 'Location tracking active' ? 'bg-green-500' :
                    connectionStatus.includes('permission') || connectionStatus === 'Locating device...' ? 'bg-yellow-500' :
                      connectionStatus === 'Error' ? 'bg-red-500' :
                        'bg-gray-500'
                  }`}></div>
                {connectionStatus}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-4">
              <button
                onClick={toggleTracking}
                className={`px-6 py-3 rounded-lg font-semibold transition-all ${isTracking
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'bg-green-500 hover:bg-green-600 text-white'
                  }`}
              >
                {isTracking ? 'Stop Tracking' : 'Start GPS Tracking'}
              </button>
              <button
                onClick={toggleSharing}
                disabled={!myPosition}
                className={`px-6 py-3 rounded-lg font-semibold transition-all ${isSharing
                    ? 'bg-orange-500 hover:bg-orange-600 text-white'
                    : 'bg-blue-500 hover:bg-blue-600 text-white disabled:bg-gray-300'
                  }`}
              >
                {isSharing ? 'Leave Network' : 'Join Network'}
              </button>
              <select
                value={hospitalRadius}
                onChange={(e) => setHospitalRadius(parseInt(e.target.value))}
                className="px-4 py-3 border rounded-lg bg-white"
              >
                <option value={2}>2 km radius</option>
                <option value={4}>4 km radius</option>
                <option value={6}>6 km radius</option>
                <option value={8}>8 km radius</option>
                <option value={10}>10 km radius</option>
                <option value={12}>12 km radius</option>
                <option value={15}>15 km radius</option>
              </select>
              <button
                onClick={() => setAutoRouting(!autoRouting)}
                className={`px-4 py-3 rounded-lg font-medium transition-all ${autoRouting
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                  }`}
                title="Automatically select shortest route to nearest hospital"
              >
                {autoRouting ? 'Auto-Route ON' : 'Auto-Route OFF'}
              </button>
            </div>
            <div className="flex items-center space-x-4">
              {!autoRouting && networkData.hospitalRoutes.length > 0 && (
                <button
                  onClick={selectShortestRoute}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition-all"
                >
                  Select Shortest Route
                </button>
              )}
              <div className={`px-4 py-2 rounded-lg text-sm font-medium ${routingStatus === 'Routes updated' || routingStatus.includes('Auto-selected') ? 'bg-green-100 text-green-800' :
                  routingStatus === 'Finding routes...' || routingStatus === 'Detecting location...' ? 'bg-blue-100 text-blue-800' :
                    routingStatus === 'Shortest route auto-selected' ? 'bg-green-100 text-green-800' :
                      'bg-gray-100 text-gray-700'
                }`}>
                {routingStatus}
              </div>
              {networkData.hospitalRoutes.length > 0 && (
                <div className="text-right">
                  <div className="font-semibold text-gray-900">
                    {networkData.hospitalRoutes.length} facilities found
                  </div>
                  <div className="text-sm text-gray-600">
                    {autoRouting ? 'Auto-routing enabled' : 'Manual selection'}
                  </div>
                </div>
              )}
            </div>
          </div>
          {locationError && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start space-x-3">
                <div className="text-red-600 text-xl">⚠️</div>
                <div className="flex-1">
                  <div className="text-red-800 font-semibold">Location Access Issue</div>
                  <div className="text-red-700 text-sm mt-1">{locationError}</div>
                  {locationPermission === 'denied' && (
                    <div className="mt-3">
                      <div className="text-red-700 text-sm font-medium mb-2">To enable location access:</div>
                      <ul className="text-red-600 text-xs space-y-1">
                        <li>1. Click the location icon in your browser's address bar</li>
                        <li>2. Select "Always allow" for location access</li>
                        <li>3. Refresh this page and try again</li>
                      </ul>
                    </div>
                  )}
                  {locationPermission === 'prompt' && (
                    <button
                      onClick={startLocationTracking}
                      className="mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium"
                    >
                      Request Location Permission
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        {selectedRoute && autoRouting && (
          <div className="bg-gradient-to-r from-green-500 to-blue-600 text-white p-6 rounded-lg mb-6 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold mb-2">
                  {selectedRoute.emergency ? 'Auto-Selected Emergency Route' : 'Auto-Selected Shortest Route'}
                </h2>
                <div className="text-green-100">
                  <div className="font-semibold text-lg">{selectedRoute.name}</div>
                  <div>Distance: {selectedRoute.roadDistance.toFixed(1)} km by road</div>
                  <div>Estimated time: {selectedRoute.estimatedTime.toFixed(0)} minutes</div>
                  {selectedRoute.route?.isFallback && (
                    <div className="text-green-200 text-sm mt-1">Note: Using direct path - road routing unavailable</div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-4xl mb-2">🎯</div>
                <div className="text-sm bg-white bg-opacity-20 px-3 py-1 rounded-full">
                  AUTO-SELECTED
                </div>
              </div>
            </div>
          </div>
        )}
        {networkData.hospitalRoutes.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">Medical Facilities (By Road Distance)</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {networkData.hospitalRoutes.slice(0, 8).map((hospital, index) => {
                const priority = getPriorityBadge(hospital);
                return (
                  <div
                    key={hospital.id}
                    onClick={() => selectHospitalRoute(hospital)}
                    className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${selectedRoute?.id === hospital.id
                        ? 'border-red-500 bg-red-50'
                        : 'border-gray-200 hover:border-red-300 bg-white'
                      }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className="text-lg">{hospital.emergency ? '🚨' : '🏥'}</span>
                          <h3 className="font-semibold text-sm">{hospital.name}</h3>
                        </div>
                        <div className={`inline-block px-2 py-1 rounded text-xs font-medium text-white ${priority.color}`}>
                          {priority.text}
                        </div>
                      </div>
                      <div className="text-right ml-4">
                        <div className="font-bold text-lg text-red-600">
                          {hospital.roadDistance.toFixed(1)} km
                        </div>
                        <div className="text-sm text-gray-600">
                          {hospital.estimatedTime.toFixed(0)} min
                        </div>
                        {index === 0 && (
                          <div className="text-xs text-green-600 font-medium">NEAREST</div>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 space-y-1">
                      {hospital.route?.isFallback && (
                        <div className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                          Direct path (road route unavailable)
                        </div>
                      )}
                      {hospital.emergency && (
                        <div className="bg-red-100 text-red-800 px-2 py-1 rounded font-medium">
                          24/7 EMERGENCY SERVICES
                        </div>
                      )}
                      {hospital.address && (
                        <div>{hospital.address}</div>
                      )}
                      {hospital.phone && hospital.phone !== 'Phone not available' && (
                        <div>{hospital.phone}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">Network Configuration</h3>
              <div className="flex space-x-2">
                {[
                  { id: 'emergency', name: 'Emergency Response', desc: 'Optimized for emergency situations' },
                  { id: 'work-optimal', name: 'Work Optimized', desc: 'Best for workplace coordination' },
                  { id: 'mst', name: 'Minimal', desc: 'Minimum connections only' }
                ].map(topology => (
                  <button
                    key={topology.id}
                    onClick={() => locationService.setNetworkTopology(topology.id)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${networkData.topology === topology.id
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      }`}
                    title={topology.desc}
                  >
                    {topology.name}
                  </button>
                ))}
              </div>
            </div>
            {networkData.connections.length > 0 && (
              <div className="text-right">
                <div className="text-sm text-gray-600">Active Network</div>
                <div className="text-lg font-bold text-blue-600">
                  {networkData.connections.length} connections
                </div>
                <div className="text-xs text-gray-500">
                  {networkData.devices.filter(d => d.isOnline && d.position).length} workers online
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-lg p-4">
          {myPosition || networkData.hospitals.length > 0 ? (
            <MapContainer
              center={centerPosition}
              zoom={13}
              style={{ height: "700px", borderRadius: "8px" }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; OpenStreetMap contributors'
              />
              <MapUpdater
                center={centerPosition}
                hospitalRoutes={networkData.hospitalRoutes}
                selectedRoute={selectedRoute}
              />
              {myPosition && (
                <Circle
                  center={myPosition}
                  radius={hospitalRadius * 1000}
                  color="#3b82f6"
                  fillColor="#bfdbfe"
                  fillOpacity={0.1}
                  weight={2}
                  dashArray="10, 10"
                />
              )}
              {myPosition && (
                <Marker position={myPosition}>
                  <Popup>
                    <div className="text-center">
                      <strong>{myDeviceName}</strong><br />
                      <span className="text-sm">Your Location</span><br />
                      {emergencyRoute && (
                        <span className="text-xs text-red-600">
                          Emergency route: {emergencyRoute.roadDistance.toFixed(1)} km
                        </span>
                      )}
                    </div>
                  </Popup>
                </Marker>
              )}
              {networkData.devices.map((device) => (
                device.position && device.id !== myDeviceId && (
                  <Marker
                    key={device.id}
                    position={device.position}
                    opacity={device.isOnline ? 1 : 0.5}
                  >
                    <Popup>
                      <div className="text-center">
                        <strong>{device.name}</strong><br />
                        <span className="text-sm">{device.workRole}</span><br />
                        {device.emergencyResponder && (
                          <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                            Emergency Responder
                          </span>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                )
              ))}
              {networkData.hospitals.map((hospital) => (
                <Marker
                  key={hospital.id}
                  position={hospital.position}
                >
                  <Popup>
                    <div className="text-center min-w-48">
                      <div className="flex items-center justify-center mb-2">
                        <span className="mr-2 text-xl">{hospital.emergency ? '🚨' : '🏥'}</span>
                        <strong>{hospital.name}</strong>
                      </div>
                      {hospital.roadDistance ? (
                        <div className="text-lg font-bold text-red-600 mb-2">
                          {hospital.roadDistance.toFixed(1)} km by road
                        </div>
                      ) : (
                        <div className="text-lg font-bold text-red-600 mb-2">
                          {hospital.distance.toFixed(1)} km direct
                        </div>
                      )}
                      {hospital.estimatedTime && (
                        <div className="text-sm text-gray-700 mb-2">
                          Est. {hospital.estimatedTime.toFixed(0)} minutes
                        </div>
                      )}
                      {hospital.emergency && (
                        <div className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-medium mb-2">
                          EMERGENCY SERVICES
                        </div>
                      )}
                      <button
                        onClick={() => selectHospitalRoute(hospital)}
                        className="bg-blue-500 text-white px-3 py-1 rounded text-sm hover:bg-blue-600"
                      >
                        Show Route
                      </button>
                    </div>
                  </Popup>
                </Marker>
              ))}
              {networkData.connections.map((connection, index) => (
                <Polyline
                  key={`${connection.from.id}-${connection.to.id}-${index}`}
                  positions={connection.positions}
                  color={connection.isEmergencyPath ? '#dc2626' : '#3b82f6'}
                  weight={connection.isEmergencyPath ? 4 : 2}
                  opacity={0.7}
                />
              ))}
              {selectedRoute?.route?.coordinates && (
                <Polyline
                  positions={selectedRoute.route.coordinates}
                  color={getRouteColor(selectedRoute)}
                  weight={6}
                  opacity={0.9}
                >
                  <Popup>
                    <div className="text-center">
                      <strong>Route to {selectedRoute.name}</strong><br />
                      <span className="text-lg font-bold text-red-600">
                        {selectedRoute.roadDistance.toFixed(1)} km
                      </span><br />
                      <span className="text-sm">
                        {selectedRoute.estimatedTime.toFixed(0)} minutes
                      </span>
                      {selectedRoute.route.isFallback && (
                        <div className="text-xs text-yellow-600 mt-1">Direct path shown</div>
                      )}
                    </div>
                  </Popup>
                </Polyline>
              )}
            </MapContainer>
          ) : (
            <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
              <div className="text-center">
                <div className="text-6xl mb-4">🏥</div>
                <p className="text-gray-600 text-lg mb-2">Emergency Response Ready</p>
                <p className="text-gray-500 text-sm">Start GPS tracking to find nearest medical facilities</p>
              </div>
            </div>
          )}
        </div>
        <div className="mt-6 bg-gradient-to-r from-blue-50 to-green-50 border border-blue-200 rounded-lg p-6">
          <h3 className="font-semibold text-blue-900 mb-3">Emergency Response System Features:</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-gray-800">
            <div>
              <h4 className="font-semibold mb-2">Road-Based Routing:</h4>
              <ul className="space-y-1">
                <li>• <strong>Accurate distances</strong> - Real road distances, not straight lines</li>
                <li>• <strong>Time estimates</strong> - Realistic travel time calculations</li>
                <li>• <strong>Turn-by-turn</strong> - Detailed route visualization on map</li>
                <li>• <strong>Auto-update</strong> - Routes recalculate as you move</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-2">Emergency Optimization:</h4>
              <ul className="space-y-1">
                <li>• <strong>Priority sorting</strong> - Emergency facilities shown first</li>
                <li>• <strong>Work network</strong> - Connect with nearby colleagues</li>
                <li>• <strong>Emergency mode</strong> - Optimized for crisis response</li>
                <li>• <strong>Real-time sync</strong> - Share locations with team members</li>
              </ul>
            </div>
          </div>
          <div className="mt-4 p-4 bg-red-100 rounded-lg">
            <h4 className="font-semibold text-red-900 mb-2">Emergency Protocol:</h4>
            <div className="text-sm text-red-800">
              1. <strong>Activate Emergency Mode</strong> for priority routing<br />
              2. <strong>Join Network</strong> to coordinate with colleagues<br />
              3. <strong>Follow road routes</strong> shown on map for fastest access<br />
              4. <strong>Share location</strong> with team for coordinated response
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}